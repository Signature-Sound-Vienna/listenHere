from flask import Flask, url_for, render_template
from app import app

@app.route("/")
@app.route("/other")
def index():
    return render_template('index.html')
@app.route("/Donau")
@app.route("/donau")
def donau():
    return render_template('listen.html', 
            data=url_for('static', filename='align/Donau.json'))
@app.route("/Radetzky")
@app.route("/radetzky")
def radetzky():
    return render_template('listen.html', 
            data=url_for('static', filename='align/Radetzky.json'))
@app.route("/Fledermaus")
@app.route("/fledermaus")
def fledermaus():
    return render_template('listen.html', 
            data=url_for('static', filename='align/Fledermaus.json'))
@app.route("/midi-test")
def midi_test():
    return render_template('listen.html', 
            data=url_for('static', filename='align/midi-test.json'))
@app.route("/Rosegarden")
@app.route("/rosegarden")
def rosegarden():
    return render_template('listen.html', 
            #data=url_for('static', filename='align/Rosegarden-midi.json'))
            #data=url_for('static', filename='align/allDonauRosegarden.json'))
            data=url_for('static', filename='align/allFledermausRosegarden.json'))
@app.route("/Kaiserwalzer")
@app.route("/kaiserwalzer")
@app.route("/Kaiser-Walzer")
@app.route("/kaiser-walzer")
def kaiserwalzer():
    return render_template('listen.html', 
            #data=url_for('static', filename='align/Rosegarden-midi.json'))
            #data=url_for('static', filename='align/allDonauRosegarden.json'))
            data=url_for('static', filename='align/Kaiserwalzer.json'))
