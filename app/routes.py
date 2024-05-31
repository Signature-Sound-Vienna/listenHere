from flask import url_for, render_template, redirect
from app import app

@app.route("/")
@app.route("/other")
def index():
    return render_template('index.html')

@app.route("/listen")
def listen(): 
    return render_template('listen.html')

@app.route("/Donau")
@app.route("/donau")
def donau():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/donau.json'),
            work_id="Donauwalzer")
@app.route("/Radetzky")
@app.route("/radetzky")
def radetzky():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/radetzky.json'),
            work_id="Radetzky")
@app.route("/Fledermaus")
@app.route("/fledermaus")
def fledermaus():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/fledermaus.json'),
            work_id="Fledermaus")
@app.route("/midi-test")
def midi_test():
    return render_template('listen.html', 
            data=url_for('static', filename='align/midi-test.json'),
            work_id="midi-test")
@app.route("/Rosegarden")
@app.route("/rosegarden")
def rosegarden():
    return render_template('listen.html', 
            #data=url_for('static', filename='align/Rosegarden-midi.json'))
            #data=url_for('static', filename='align/allDonauRosegarden.json'))
            data=url_for('static', filename='align/allFledermausRosegarden.json'),
            work_id="FledermausRosegarden")
@app.route("/Kaiserwalzer")
@app.route("/kaiserwalzer")
@app.route("/Kaiser-Walzer")
@app.route("/kaiser-walzer")
def kaiserwalzer():
    return render_template('listen.html', 
            #data=url_for('static', filename='align/Rosegarden-midi.json'))
            #data=url_for('static', filename='align/allDonauRosegarden.json'))
            data=url_for('static', filename='align/scoreAlign/kaiserwalzer.json'),
            work_id="Kaiserwalzer")
@app.route("/Pizzicato")
@app.route("/pizzicato")
def pizzicato():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/pizzicato.json'),
            work_id="Pizzicato")
@app.route("/Spheres")
@app.route("/spheres")
def spheres():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/sphaerenklaenge.json'),
            work_id="Sphärenklänge")
@app.route("/Eljen")
@app.route("/eljen")
def eljen():
    return render_template('listen.html', 
            data=url_for('static', filename='align/scoreAlign/eljen.json'),
            work_id="Eljen")
@app.route("/test")
def test():
    return redirect("/listen?data=/static/align/test.json&work=test", code=302)