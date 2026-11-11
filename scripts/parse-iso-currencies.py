"""Read a local ISO 4217 List One XML; no network and no XML entities."""
import json
import re
import sys
from pathlib import Path
import xml.etree.ElementTree as ET
raw = Path(sys.argv[1]).read_bytes()
if len(raw) > 2_000_000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
    raise ValueError('XML invalide ou trop volumineux')
root = ET.fromstring(raw)
date = root.attrib.get('Pblshd', '')
if root.tag != 'ISO_4217' or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
    raise ValueError('Document ISO 4217 List One daté obligatoire')
rows = {}
for entry in root.findall('./CcyTbl/CcyNtry'):
    code, number, precision = (entry.findtext(k, '') for k in ['Ccy', 'CcyNbr', 'CcyMnrUnts'])
    if precision == 'N.A.' or not code:
        continue
    if not re.fullmatch('[A-Z]{3}', code) or not re.fullmatch('[0-9]{3}', number) or precision not in ['0','1','2','3','4']:
        raise ValueError('Identifiant ou précision non pris en charge')
    row = {'code': code, 'numericCode': number, 'precision': int(precision), 'sourceDate': date}
    if code in rows and rows[code] != row:
        raise ValueError('Métadonnées ISO contradictoires')
    rows[code] = row
if not rows or len(rows) > 300:
    raise ValueError('Catalogue vide ou trop volumineux')
print(json.dumps(sorted(rows.values(), key=lambda v: v['code'])))
