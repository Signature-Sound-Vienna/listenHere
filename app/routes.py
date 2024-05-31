from flask import url_for, render_template, redirect
from app import app

@app.route("/")
@app.route("/other")
def index():
    return render_template('index.html')

@app.route("/listen")
def listen(): 
    return render_template('listen.html')

@app.route("/test")
def test():
    return redirect("/listen?data=/static/align/test.json&work=test", code=302)
