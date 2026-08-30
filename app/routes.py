from flask import url_for, render_template, redirect, request, send_from_directory
from markupsafe import escape
from app import app
import json
import os
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
        if isinstance(val, list):
            # Plain array of times (no precomputed peaks)
            if not all(isinstance(t, (int, float)) for t in val):
                return False, f"Audio entry '{key}': time values must be numbers"
        elif isinstance(val, dict):
            # Inline format with precomputed peaks: {times, peaks, duration}
            if "times" not in val or not isinstance(val["times"], list):
                return False, f"Audio entry '{key}' must have a 'times' array"
            if not all(isinstance(t, (int, float)) for t in val["times"]):
                return False, f"Audio entry '{key}' times must contain only numbers"
            if "peaks" in val and not isinstance(val["peaks"], list):
                return False, f"Audio entry '{key}' peaks must be an array"
            if "duration" in val and not isinstance(val["duration"], (int, float)):
                return False, f"Audio entry '{key}' duration must be a number"
        else:
            return False, f"Audio entry '{key}' must be an array of times or an object with times/peaks/duration"
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
    mode = request.args.get("mode", "")

    # ?mode=align — in-browser alignment workflow
    if mode == "align":
        return render_template('listen.html', data="none", mode="align")

    if not align_url:
        # If ?useFiles is present without ?align=, serve listen page in local mode
        if request.args.get("useFiles") is not None:
            return render_template('listen.html', data="local", mode="listen")
        error = request.args.get("error")
        return render_template('index.html', error=error)

    # Legacy: alignment stored in sessionStorage (from old /align page)
    if align_url == "session":
        return render_template('listen.html', data="session", mode="listen")

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

    return render_template('listen.html', data=align_url, mode="listen")


@app.route("/solid-popup-callback")
def solid_popup_callback():
    return render_template('solid-popup-callback.html')


# ---------------------------------------------------------------------------
# Test fixtures (development only — serves tests/fixtures/ as /static/test/)
# ---------------------------------------------------------------------------

@app.route("/static/test/<path:filename>")
def test_fixtures(filename):
    if not app.debug:
        from flask import abort
        abort(404)
    fixtures_dir = os.path.join(os.path.dirname(app.root_path), 'tests', 'fixtures')
    return send_from_directory(fixtures_dir, filename)


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

@app.route("/exhibit")
def exhibit():
    # The museum exhibit (plan §4.1). A redirect rather than a rendered template
    # on purpose: the page lives entirely under /static/exhibit/ and imports the
    # shared engine modules by RELATIVE path, exactly as every other first-party
    # module in this codebase does. Serving it from /exhibit would break those
    # paths and push the page towards absolute specifiers, which the boundary
    # test (spec 33) would have to be taught to follow.
    #
    # The exhibit must never import listen.js. That is enforced, not trusted:
    # tests/e2e/33-exhibit-boundary.spec.ts, ratcheted at zero.
    #
    # The query string MUST survive the redirect: display geometry is entirely
    # URL-driven (exhibit/config.js), so laptop, iPad, and table are three URLs of
    # one build. A bare redirect drops it and silently serves the defaults, which
    # is how /exhibit?viewports=1 came back with two viewports the first time.
    target = "/static/exhibit/index.html"
    qs = request.query_string.decode("utf-8", "ignore").replace("\r", "").replace("\n", "")
    if qs:
        target += "?" + qs
    return redirect(target, code=302)


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

@app.route("/align")
def align():
    return redirect("/?mode=align", code=302)
