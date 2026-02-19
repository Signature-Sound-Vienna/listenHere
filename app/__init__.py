from flask import Flask

app = Flask(__name__)

app.config['VERSION'] = '0.8.0'
app.config['VERSION_DATE'] = '19 February 2026'

@app.context_processor
def inject_version():
    return dict(version=app.config['VERSION'], version_date=app.config['VERSION_DATE'])

from app import routes
