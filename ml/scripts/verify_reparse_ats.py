import asyncio
import psycopg
from ml.config import settings
from ml.storage.s3 import download_file
from ml.pipelines.intake.parser import parse_document
from ml.pipelines.intake.repository import save_parsed_resume

with psycopg.connect(settings.database_url) as conn:
    with conn.cursor() as cur:
        cur.execute('SELECT id, "storageKey", "mimeType", "originalFilename" FROM resumes ORDER BY "createdAt" DESC LIMIT 5;')
        resumes = cur.fetchall()

for r_id, s_key, m_type, f_name in resumes:
    temp_path = f"/tmp/{r_id}.pdf"
    download_file(s_key, temp_path)
    result = parse_document(temp_path, m_type or "application/pdf")
    print(f"=== {f_name} ===")
    print(f"Score: {result.ats_score}")
    print(f"Hazards: {[h.code for h in result.ats_hazards]}")
    for h in result.ats_hazards:
        print(f"  - [{h.severity}] {h.code}: {h.description}")
    print(f"Subscores: {result.parsing_metadata.get('ats_subscores')}")
    print(f"Experience Source: {result.parsing_metadata.get('experience_source')}")
    total_bullets = sum(len(e.bullets) for e in result.experience)
    print(f"Total Bullets Extracted: {total_bullets}")
    # Update database so user sees the new scores immediately!
    save_parsed_resume(r_id, result)
    print("Database updated!")
    print()
