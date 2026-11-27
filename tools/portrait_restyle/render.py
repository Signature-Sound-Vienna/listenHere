"""Drive the local ComfyUI (127.0.0.1:8188) to restyle exhibit portraits with
Qwen-Image-Edit-2511 (Q6_K GGUF) + the Lightning 4-step LoRA.

The prompt is a TEMPLATE (prompts/*.txt); `{facts}` is replaced by the sitter's
authored sentence from sitters.json. Every render's full recipe (resolved
prompt, template file and its SHA-256, facts, model files, seed, sampler,
timing) is stored twice: appended to renders.jsonl (committed) and written as a
sidecar OUT/<name>.json next to the image (gitignored cache).

usage: render.py PROMPT_FILE SEED[,SEED...] (SLUG [SLUG...] | all) [--ref PATH]
"""
import hashlib, json, os, shutil, sys, time, urllib.request, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import COMFY, FACTS, INPUTS, LOG, OUT, REPO, sitters

HOST = "http://127.0.0.1:8188"

UNET = "qwen-image-edit-2511-Q6_K.gguf"
CLIP = "qwen_2.5_vl_7b.safetensors"
VAE = "qwen_image_vae.safetensors"
LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
STEPS, CFG, SHIFT = 4, 1.0, 3.1


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HOST + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def graph(image_name, prompt, seed, ref_name=None):
    g = {
        "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": UNET}},
        "lora": {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"model": ["unet", 0], "lora_name": LORA, "strength_model": 1.0}},
        "shift": {"class_type": "ModelSamplingAuraFlow",
                  "inputs": {"model": ["lora", 0], "shift": SHIFT}},
        "norm": {"class_type": "CFGNorm", "inputs": {"model": ["shift", 0], "strength": 1.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "scale": {"class_type": "ImageScaleToTotalPixels",
                  "inputs": {"image": ["img", 0], "upscale_method": "lanczos",
                             "megapixels": 1.0, "resolution_steps": 8}},
        "pos": {"class_type": "TextEncodeQwenImageEditPlus",
                "inputs": {"clip": ["clip", 0], "prompt": prompt, "vae": ["vae", 0],
                           "image1": ["scale", 0]}},
        "neg": {"class_type": "TextEncodeQwenImageEditPlus",
                "inputs": {"clip": ["clip", 0], "prompt": "", "vae": ["vae", 0],
                           "image1": ["scale", 0]}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": ["vae", 0]}},
        "ks": {"class_type": "KSampler",
               "inputs": {"model": ["norm", 0], "seed": seed, "steps": STEPS, "cfg": CFG,
                          "sampler_name": "euler", "scheduler": "simple",
                          "positive": ["pos", 0], "negative": ["neg", 0],
                          "latent_image": ["enc", 0], "denoise": 1.0}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["dec", 0], "filename_prefix": "restyle"}},
    }
    if image_name is None:  # text only: "from memory", no photograph in the loop
        for k in ("img", "scale", "enc"):
            del g[k]
        for k in ("pos", "neg"):
            del g[k]["inputs"]["image1"]
        g["enc"] = {"class_type": "EmptySD3LatentImage",
                    "inputs": {"width": 1024, "height": 1024, "batch_size": 1}}
    if ref_name:
        g["ref"] = {"class_type": "LoadImage", "inputs": {"image": ref_name}}
        g["refscale"] = {"class_type": "ImageScaleToTotalPixels",
                         "inputs": {"image": ["ref", 0], "upscale_method": "lanczos",
                                    "megapixels": 1.0, "resolution_steps": 8}}
        for k in ("pos", "neg"):
            g[k]["inputs"]["image2"] = ["refscale", 0]
    return g


def sitter_facts(slug):
    """Authored per-sitter prompt data (sitters.json): `facts`, `clothes`.

    A variant 'slug.variant' inherits its sitter's entry and overrides field by
    field, so a crop-only variant keeps the sitter's facts without restating them.
    """
    data = json.load(open(FACTS, encoding="utf-8"))
    base, own = data.get(slug.split(".")[0], {}), data.get(slug, {})
    if not isinstance(base, dict):
        base = {}
    return {**base, **own} if isinstance(own, dict) else base


def run(slug, template, template_file, prompt_tag, seed, ref=None):
    facts = sitter_facts(slug)
    # `{clothes}` (p4) defaults to p3's own words, so p4 without an override IS p3.
    clothes = facts.get("clothes", "in a dark concert suit")
    prompt = " ".join(template.replace("{facts}", facts.get("facts", ""))
                      .replace("{clothes}", clothes).split())
    text_only = slug.endswith("-memory")
    if not text_only:
        src = os.path.join(INPUTS, f"in-{slug}.png")
        shutil.copy(src, os.path.join(COMFY, "input", f"restyle-in-{slug}.png"))
    ref_name = None
    if ref:
        ref_name = "restyle-ref-" + os.path.basename(ref)
        shutil.copy(ref, os.path.join(COMFY, "input", ref_name))
    t0 = time.time()
    image_name = None if text_only else f"restyle-in-{slug}.png"
    pid = call("/prompt", {"prompt": graph(image_name, prompt, seed, ref_name),
                           "client_id": str(uuid.uuid4())})["prompt_id"]
    while True:
        h = call(f"/history/{pid}")
        if pid in h:
            break
        time.sleep(2)
    entry = h[pid]
    status = entry.get("status", {})
    if status.get("status_str") != "success":
        raise SystemExit(f"{slug} seed {seed} failed: {json.dumps(status)[:1500]}")
    img = entry["outputs"]["save"]["images"][0]
    produced = os.path.join(COMFY, "output", img.get("subfolder", ""), img["filename"])
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, f"{slug}-{prompt_tag}-s{seed}.png")
    shutil.copy(produced, dest)
    dt = time.time() - t0
    rec = {"slug": slug, "seed": seed, "prompt_tag": prompt_tag,
           "template_file": os.path.relpath(template_file, REPO),
           "template_sha256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
           "facts": facts.get("facts", ""), "facts_basis": facts.get("basis"), "clothes": clothes,
           "prompt": prompt, "negative_prompt": "",
           "input": None if text_only else os.path.relpath(src, REPO),
           "ref": ref and os.path.relpath(ref, REPO),
           "unet": UNET, "clip": CLIP, "vae": VAE, "lora": LORA, "lora_strength": 1.0,
           "steps": STEPS, "cfg": CFG, "shift": SHIFT, "sampler": "euler/simple",
           "megapixels": 1.0, "seconds": round(dt, 1),
           "out": os.path.relpath(dest, REPO), "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(os.path.splitext(dest)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=1)
    print(f"{slug} {prompt_tag} seed {seed}: {dt:.1f}s -> {os.path.basename(dest)}", flush=True)


def main():
    args = sys.argv[1:]
    ref = None
    if "--ref" in args:
        i = args.index("--ref")
        ref = args[i + 1]
        del args[i:i + 2]
    prompt_file, seeds, slugs = args[0], [int(s) for s in args[1].split(",")], args[2:]
    if slugs == ["all"]:
        slugs = sitters()
    prompt_file = os.path.abspath(prompt_file)
    template = open(prompt_file, encoding="utf-8").read().strip()
    tag = os.path.splitext(os.path.basename(prompt_file))[0]
    for slug in slugs:
        for seed in seeds:
            dest = os.path.join(OUT, f"{slug}-{tag}-s{seed}.png")
            if os.path.exists(dest):  # resumable: never redo (or overwrite) a finished render
                print(f"{slug} {tag} seed {seed}: exists, skipped", flush=True)
                continue
            run(slug, template, prompt_file, tag, seed, ref)


if __name__ == "__main__":
    main()
