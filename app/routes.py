from flask import Flask, url_for, render_template
from app import app

@app.route("/")
def index():
    return render_template('index.html')
@app.route("/other")
def other():
    return render_template('other.html')
@app.route("/Donau")
@app.route("/donau")
def donau():
    return render_template('choose.html', 
            data=url_for('static', filename='align/Donau.json'))
@app.route("/Radetzky")
@app.route("/radetzky")
def radetzky():
    return render_template('choose.html', 
            data=url_for('static', filename='align/Radetzky.json'))
@app.route("/old")
def old():
    return render_template('old.html')


