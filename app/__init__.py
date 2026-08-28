from datetime import datetime
from flask import Flask

app = Flask(__name__)

app.config['VERSION'] = '0.38.0'
app.config['VERSION_DATE'] = '28 August 2026'
app.config['VERSION_DATE_ISO'] = datetime.strptime(app.config['VERSION_DATE'], '%d %B %Y').strftime('%Y-%m-%d')

@app.context_processor
def inject_version():
    return dict(version=app.config['VERSION'], version_date=app.config['VERSION_DATE'], version_date_iso=app.config['VERSION_DATE_ISO'])

from app import routes
