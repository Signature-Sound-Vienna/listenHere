from flask import Flask, url_for, render_template
from app import app

@app.route("/")
def index():
    return render_template('index.html')
@app.route("/other")
def other():
    return render_template('other.html')
@app.route("/old")
def old():
    return render_template('old.html')


