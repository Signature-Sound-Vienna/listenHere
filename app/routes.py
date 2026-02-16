from flask import url_for, render_template, redirect, request
from markupsafe import escape
from app import app
import json
import urllib.request
import urllib.error


def validate_alignment_json(data):
    """Validate alignment JSON schema. Returns (is_valid, error_message)."""
    if not isinstance(data, dict):
        return False, "Alignment data must be a JSON object"
    if "body" not in data:
        return False, "Missing required 'body' field"
    body = data["body"]
    if not isinstance(body, dict):
        return False, "'body' must be an object"
    if "audio" not in body:
        return False, "Missing required 'audio' field in body"
    audio = body["audio"]
    if not isinstance(audio, dict):
        return False, "'audio' must be an object"
    if len(audio) == 0:
        return False, "'audio' must contain at least one entry"
    for key, val in audio.items():
        if not isinstance(val, list):
            return False, "Each audio entry must be an array of times"
        if not all(isinstance(t, (int, float)) for t in val):
            return False, "Audio time arrays must contain only numbers"
    if "header" not in data:
        return False, "Missing required 'header' field"
    header = data["header"]
    if not isinstance(header, dict):
        return False, "'header' must be an object"
    if "ref" not in header:
        return False, "Missing required 'ref' field in header"
    if header["ref"] not in audio:
        return False, "'ref' must reference one of the audio entries"
    # Validate optional score section
    has_score = "score" in body
    has_mei = "meiUri" in header
    if has_score != has_mei:
        return False, "If 'score' is provided, 'meiUri' must also be provided (and vice versa)"
    if has_score:
        score = body["score"]
        if not isinstance(score, dict):
            return False, "'score' must be an object"
        for key in ("score_onset", "ref_onset", "score_offset", "ref_offset"):
            if key not in score:
                return False, f"Missing required score field: '{key}'"
            if not isinstance(score[key], list):
                return False, f"Score field '{key}' must be an array"
            if not all(isinstance(t, (int, float)) for t in score[key]):
                return False, f"Score field '{key}' must contain only numbers"
    return True, None


@app.route("/")
def index():
    align_url = request.args.get("align")
    if not align_url:
        error = request.args.get("error")
        return render_template('index.html', error=error)

    # Fetch and validate the alignment JSON server-side
    try:
        req = urllib.request.Request(align_url, headers={"User-Agent": "ListenHere/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        return render_template('index.html',
                               error=f"Could not fetch alignment data: {escape(str(e))}")

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return render_template('index.html',
                               error="The URL did not return valid JSON")

    is_valid, err = validate_alignment_json(data)
    if not is_valid:
        return render_template('index.html',
                               error=f"Invalid alignment data: {escape(err)}")

    return render_template('listen.html', data=align_url)


SSV_AUDIO = "https://w3id.org/ssv/audio/"

@app.route("/listen")
def listen():
    # Legacy route: redirect to new /?align= scheme if params present
    data = request.args.get("data")
    if data:
        return redirect(f"/?align={data}", code=302)
    return redirect("/", code=302)

@app.route("/Donau")
@app.route("/donau")
def donau():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/donau.json", code=302)

@app.route("/Radetzky")
@app.route("/radetzky")
def radetzky():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/radetzky.json", code=302)

@app.route("/Fledermaus")
@app.route("/fledermaus")
def fledermaus():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/fledermaus.json", code=302)

@app.route("/midi-test")
def midi_test():
    return redirect(f"/?align={SSV_AUDIO}align/midi-test.json", code=302)

@app.route("/Rosegarden")
@app.route("/rosegarden")
def rosegarden():
    return redirect(f"/?align={SSV_AUDIO}align/allFledermausRosegarden.json", code=302)

@app.route("/Kaiserwalzer")
@app.route("/kaiserwalzer")
@app.route("/Kaiser-Walzer")
@app.route("/kaiser-walzer")
def kaiserwalzer():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/KW-realign-primal.json", code=302)

@app.route("/Pizzicato")
@app.route("/pizzicato")
def pizzicato():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/pizzicato.json", code=302)

@app.route("/Spheres")
@app.route("/spheres")
def spheres():
    return redirect(f"/?align={SSV_AUDIO}align/scoreAlign/sphaerenklaenge.json", code=302)

@app.route("/Eljen")
@app.route("/eljen")
def eljen():
    return redirect(f"/?align={SSV_AUDIO}align/TISMIR/TISMIR-Eljen.json", code=302)

@app.route("/test")
def test():
    return redirect(f"/?align=/static/align/test.json", code=302)
