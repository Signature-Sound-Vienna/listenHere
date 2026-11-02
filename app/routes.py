from flask import url_for, render_template, redirect, request, send_from_directory
from app import app
import os


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

    # The browser fetches and validates the alignment (alignment-validate.js)
    # and comes back here with ?error= if it can't. The server never fetches
    # the URL itself: it would fetch whatever it was given, local files and
    # internal hosts included, and download every alignment twice.
    return render_template('listen.html', data=align_url, mode="listen")


@app.route("/solid-popup-callback")
def solid_popup_callback():
    return render_template('solid-popup-callback.html')


# ---------------------------------------------------------------------------
# Test fixtures (development only — serves tests/fixtures/ as /static/test/)
# ---------------------------------------------------------------------------

# The origin the JSON fixtures are written against (alignment.json's meiUri).
# The harness reads its base URL from APP_BASE_URL, so a tree under test on
# another port would otherwise fetch the MEI from whatever server holds :5001
# — a server running OTHER code. Rewritten at serve time to this request's
# own origin; a fixture served from the default port is byte-identical.
FIXTURE_ORIGIN = "http://localhost:5001"

@app.route("/static/test/<path:filename>")
def test_fixtures(filename):
    if not app.debug:
        from flask import abort
        abort(404)
    fixtures_dir = os.path.join(os.path.dirname(app.root_path), 'tests', 'fixtures')
    if filename.endswith('.json'):
        from flask import Response
        from werkzeug.utils import safe_join
        path = safe_join(fixtures_dir, filename)
        origin = request.host_url.rstrip('/')
        if path and os.path.isfile(path) and origin != FIXTURE_ORIGIN:
            with open(path, encoding='utf-8') as fh:
                text = fh.read()
            return Response(text.replace(FIXTURE_ORIGIN, origin),
                            mimetype='application/json')
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
