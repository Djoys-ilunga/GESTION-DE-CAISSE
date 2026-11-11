"""Inventaires reproductibles du commit audité ; aucune lecture de .env ou de base."""

from pathlib import Path
import csv
import hashlib
import json
import re
import subprocess

BASE = "a347622b28952db2408cad3f0d30a06af2a94930"
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def category(path):
    if "/test/" in path or path.startswith(("tests/", "scripts/test-")) or ".test." in path or path.endswith(("tests.rs", "api_contract.rs")):
        return "tests"
    if path.startswith("apps/api/prisma/migrations/"):
        return "migrations-historiques"
    if path.startswith("apps/api/prisma/"):
        return "schema-prisma"
    if path.startswith("apps/api/"):
        return "api"
    if path.startswith("apps/desktop/src-tauri/") or path.startswith(("packages/session-core/", "packages/local-store/")):
        return "natif-et-stockage-local"
    if path.startswith("apps/desktop/"):
        return "interface"
    if path.startswith("packages/shared/"):
        return "contrats-partages"
    if path.startswith("scripts/"):
        return "outils"
    if path.startswith("docs/") or path.endswith(".md"):
        return "documentation"
    return "configuration"


def write_tsv(name, header, rows):
    with (OUT / name).open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


paths = git("ls-tree", "-r", "--name-only", BASE).decode().splitlines()
currency, numeric, sql_objects, money_fields, hashes = [], [], [], [], []
texts, models = 0, []
excluded_locks = []
numeric_re = re.compile(r"Decimal|numeric\s*\(|NUMERIC\s*\(|toFixed|toDecimalPlaces|ROUND_HALF|HALF_UP_2|round\s*\(|parseFloat|\bf(?:32|64)\b|\bNumber\s*\(|\.length\(2\)|\.len\(\)\s*==\s*2\b|jsonb_array_length|\{2\}|\b732\b|counted(?:USD|CDF)|FractionDigits")
sql_re = re.compile(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(FUNCTION|VIEW|TRIGGER|POLICY)\s+([^\s(]+)|\bADD\s+CONSTRAINT\s+([^\s]+)", re.I)
for path in paths:
    if path.endswith("Cargo.lock") or path == "pnpm-lock.yaml":
        excluded_locks.append(path)
        continue
    blob = git("show", f"{BASE}:{path}")
    if path.startswith("apps/api/prisma/migrations/") and path.endswith(".sql"):
        hashes.append(f"{hashlib.sha256(blob).hexdigest()}  {path}")
    if b"\0" in blob:
        continue
    try:
        content = blob.decode("utf-8")
    except UnicodeDecodeError:
        continue
    texts += 1
    model = None
    for number, line in enumerate(content.splitlines(), 1):
        kind = category(path)
        if re.search("cdf|usd", line, re.I):
            currency.append([kind, path, number, line.strip()])
        if path.startswith(("apps/", "packages/", "scripts/", "tests/")) and numeric_re.search(line):
            numeric.append([kind, path, number, line.strip()])
        if path.startswith("apps/api/prisma/migrations/"):
            for match in sql_re.finditer(line):
                sql_objects.append([path, number, match[1] or "CONSTRAINT", match[2] or match[3], line.strip()])
        if path == "apps/api/prisma/schema.prisma":
            match = re.match(r"model (\w+) \{", line)
            if match:
                model = match[1]
                models.append(model)
            elif line == "}":
                model = None
            elif model and re.search(r"\bCurrency\??\b|@db\.Decimal|\bJson\b", line):
                money_fields.append([model, number, line.strip()])

write_tsv("occurrences-cdf-usd.tsv", ["categorie", "fichier", "ligne", "extrait"], currency)
write_tsv("precision-et-calculs.tsv", ["categorie", "fichier", "ligne", "extrait"], numeric)
write_tsv("objets-sql-historiques.tsv", ["migration", "ligne", "type", "objet", "declaration"], sql_objects)
write_tsv("champs-prisma.tsv", ["modele", "ligne", "declaration"], money_fields)
(OUT / "migrations.sha256").write_text("\n".join(hashes) + "\n", encoding="utf-8")
summary = {
    "commit_audite": BASE,
    "fichiers_texte_scannes": texts,
    "verrouillages_exclus": excluded_locks,
    "modeles_prisma": models,
    "migrations_sql": len(hashes),
    "lignes_cdf_usd": len(currency),
    "fichiers_cdf_usd": len({row[1] for row in currency}),
    "categories_cdf_usd": {kind: sum(row[0] == kind for row in currency) for kind in sorted({row[0] for row in currency})},
    "lignes_precision_et_calculs": len(numeric),
    "declarations_sql_historiques": len(sql_objects),
}
(OUT / "inventaire.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=2))
