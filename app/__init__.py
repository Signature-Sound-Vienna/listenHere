from flask import Flask

app = Flask(__name__)

app.config['VERSION'] = '0.13.0'
app.config['VERSION_DATE'] = '15 March 2026'

@app.context_processor
def inject_version():
    return dict(version=app.config['VERSION'], version_date=app.config['VERSION_DATE'])

from app import routes
