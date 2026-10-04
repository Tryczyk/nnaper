import json
from datetime import datetime

def any_none(arguments):
    for element in arguments:
        if element is None:
            return True
    return False

def save_geojson(filename, features):
    with open(filename, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

def ddm_to_dd(ddm_str, hemisphere):
    if any_none([ddm_str, hemisphere]):
        return

    val = float(ddm_str)
    degrees = int(val // 100)
    minutes = val % 100
    
    decimal = degrees + (minutes / 60)
    
    if hemisphere in ['S', 'W']:
        decimal *= -1
        
    return decimal

def parse_nmea_time(val):
    if not val or len(val) < 6:
        return None
    try:
        return datetime.strptime(val[:6], "%H%M%S").time()
    except ValueError:
        return None

def to_int_or_none(val):
    if val is None:
        return None
    val_str = str(val).strip()
    return int(val_str) if val_str.isdigit() else None