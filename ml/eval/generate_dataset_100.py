"""
Phase 10A - Item D2: Evaluation Dataset Expansion to 100+ Pairs

Generates diverse synthetic resumes, job descriptions, and labeled pairs:
- Diverse roles: Backend, Frontend, Fullstack, DevOps, ML/AI, Data Science, Security, Mobile, QA, Product
- Ground-truth levels: strong (direct match), medium (adjacent / transferrable), weak (irrelevant)
- Strictly formatted to match schema: resume, job, expected, reason
"""

from __future__ import annotations

import csv
from pathlib import Path

ROLES = [
    {
        "domain": "backend_go",
        "title": "Senior Go Systems Engineer",
        "skills": ["Go", "gRPC", "PostgreSQL", "Docker", "Kubernetes", "Distributed Systems"],
        "resume_text": "Senior Systems Engineer with 6 years building high-throughput services in Go, gRPC, and PostgreSQL.",
        "job_text": "Seeking Senior Go Systems Engineer with strong experience in Go, gRPC, distributed systems, and Kubernetes.",
    },
    {
        "domain": "backend_java",
        "title": "Java Spring Boot Architect",
        "skills": ["Java", "Spring Boot", "Kafka", "PostgreSQL", "Microservices", "AWS"],
        "resume_text": "Enterprise Java Architect specializing in Spring Boot microservices, Kafka event streaming, and AWS deployments.",
        "job_text": "Looking for Java Spring Boot Architect to lead enterprise event-driven microservices architecture using Kafka.",
    },
    {
        "domain": "frontend_vue",
        "title": "Senior Vue.js / Nuxt Developer",
        "skills": ["Vue.js", "Nuxt.js", "TypeScript", "Tailwind CSS", "Pinia", "Vite"],
        "resume_text": "Frontend developer with 5 years crafting scalable web applications in Vue 3, Nuxt, and TypeScript.",
        "job_text": "Hiring Senior Vue.js Developer experienced with Vue 3, Nuxt.js, TypeScript, and modern frontend state management.",
    },
    {
        "domain": "mobile_ios",
        "title": "Senior iOS Engineer (Swift)",
        "skills": ["Swift", "SwiftUI", "Combine", "CoreData", "iOS SDK", "XCTest"],
        "resume_text": "iOS Engineer with 7 years shipping App Store applications using Swift, SwiftUI, and Combine.",
        "job_text": "Seeking Senior iOS Engineer with deep expertise in Swift, modern SwiftUI architecture, and unit testing.",
    },
    {
        "domain": "security_eng",
        "title": "Application Security Engineer",
        "skills": ["AppSec", "Threat Modeling", "SAST/DAST", "OAuth2", "Cryptography", "Penetration Testing"],
        "resume_text": "Application Security Engineer with expertise in STRIDE threat modeling, ASVS verification, and secure API design.",
        "job_text": "Looking for Application Security Engineer to establish security quality gates, conduct threat models, and harden APIs.",
    },
    {
        "domain": "qa_automation",
        "title": "Lead SDET / QA Automation Engineer",
        "skills": ["Playwright", "Cypress", "TypeScript", "CI/CD", "Load Testing", "k6"],
        "resume_text": "Lead SDET with 8 years building end-to-end testing frameworks using Playwright, TypeScript, and k6.",
        "job_text": "Hiring Lead QA Automation Engineer to design automated regression pipelines in Playwright and CI/CD.",
    },
    {
        "domain": "data_engineer",
        "title": "Staff Data Engineer (Spark / Snowflake)",
        "skills": ["Apache Spark", "Snowflake", "dbt", "Python", "Airflow", "SQL"],
        "resume_text": "Staff Data Engineer with 7 years orchestrating terabyte-scale data lakes with Spark, dbt, Snowflake, and Airflow.",
        "job_text": "Seeking Staff Data Engineer to design modern data platform with Apache Spark, Airflow, and Snowflake.",
    },
    {
        "domain": "devops_cloud",
        "title": "Cloud Platform Engineer (Terraform / GCP)",
        "skills": ["Terraform", "GCP", "Kubernetes", "Prometheus", "CI/CD", "Linux"],
        "resume_text": "Platform Engineer specializing in Google Cloud Platform infrastructure as code with Terraform and GKE.",
        "job_text": "Hiring Cloud Platform Engineer with proven track record in Terraform, GCP, and Kubernetes cluster management.",
    },
    {
        "domain": "product_mgr",
        "title": "Technical Product Manager (Developer Platforms)",
        "skills": ["Product Strategy", "API Design", "Agile", "User Research", "Metrics", "Roadmapping"],
        "resume_text": "Technical PM with 6 years leading developer platform initiatives, public APIs, and developer experience metrics.",
        "job_text": "Seeking Technical Product Manager to own developer APIs, platform instrumentation, and feature prioritization.",
    },
    {
        "domain": "sales_exec",
        "title": "Enterprise Account Executive (SaaS)",
        "skills": ["B2B Sales", "Quota Attainment", "CRM", "Contract Negotiation", "Lead Generation"],
        "resume_text": "Top-performing Enterprise SaaS Account Executive with 8 years exceeding $2M annual recurring revenue quotas.",
        "job_text": "Looking for Enterprise Account Executive to drive B2B software sales across Fortune 500 accounts.",
    },
]


def generate_extended_dataset(output_dir: str = "test-data/extended_dataset") -> int:
    out_path = Path(output_dir)
    resumes_dir = out_path / "resumes"
    jobs_dir = out_path / "jobs"
    resumes_dir.mkdir(parents=True, exist_ok=True)
    jobs_dir.mkdir(parents=True, exist_ok=True)

    # 1. Generate Resume and Job files for all 10 roles
    for role in ROLES:
        r_name = f"resume_{role['domain']}.txt"
        j_name = f"job_{role['domain']}.txt"

        with open(resumes_dir / r_name, "w", encoding="utf-8") as f:
            f.write(f"NAME: Candidate for {role['title']}\n")
            f.write(f"SKILLS: {', '.join(role['skills'])}\n")
            f.write(f"SUMMARY: {role['resume_text']}\n")
            f.write("EXPERIENCE: 6+ years professional experience delivering production results.\n")

        with open(jobs_dir / j_name, "w", encoding="utf-8") as f:
            f.write(f"TITLE: {role['title']}\n")
            f.write(f"REQUIRED SKILLS: {', '.join(role['skills'])}\n")
            f.write(f"DESCRIPTION: {role['job_text']}\n")

    # 2. Generate 100+ pairwise labeled examples
    pairs: list[dict[str, str]] = []

    # 10 Strong direct matches (R_i <-> J_i)
    for role in ROLES:
        pairs.append({
            "resume": f"resume_{role['domain']}.txt",
            "job": f"job_{role['domain']}.txt",
            "expected": "strong",
            "reason": f"Direct technical stack and seniority match for {role['title']}",
        })

    # Adjacent / Medium pairs (cross-domain engineering matches)
    adjacent_pairs = [
        ("backend_go", "backend_java", "Backend systems overlap, but language stack differs (Go vs Java)"),
        ("backend_go", "devops_cloud", "Strong Kubernetes and Linux overlap, but infrastructure focus differs"),
        ("backend_java", "backend_go", "Backend microservices overlap, but Go and gRPC missing"),
        ("data_engineer", "backend_go", "Python and database experience, but lack of Go systems background"),
        ("security_eng", "backend_go", "API security knowledge, but primary software development stack differs"),
        ("qa_automation", "frontend_vue", "TypeScript and web automation overlap, but lacks deep Vue component design"),
        ("devops_cloud", "backend_go", "Cloud infrastructure overlap, but lacks core application code depth"),
        ("mobile_ios", "frontend_vue", "Client-side frontend concepts, but iOS Swift native vs Vue web"),
        ("product_mgr", "backend_go", "Technical understanding of APIs, but lacks hands-on engineering execution"),
        ("qa_automation", "devops_cloud", "CI/CD and automation overlap, but lacks cloud infrastructure ownership"),
    ]

    for r_dom, j_dom, reason in adjacent_pairs:
        pairs.append({
            "resume": f"resume_{r_dom}.txt",
            "job": f"job_{j_dom}.txt",
            "expected": "medium",
            "reason": reason,
        })

    # Weak / Irrelevant pairs (cross domain mismatches)
    for r_role in ROLES:
        for j_role in ROLES:
            if r_role["domain"] == j_role["domain"]:
                continue
            # Non-technical sales vs technical roles or completely divergent fields
            if r_role["domain"] == "sales_exec" and j_role["domain"] != "sales_exec":
                pairs.append({
                    "resume": f"resume_{r_role['domain']}.txt",
                    "job": f"job_{j_role['domain']}.txt",
                    "expected": "weak",
                    "reason": f"Non-technical sales background applied to {j_role['title']}",
                })
            elif j_role["domain"] == "sales_exec" and r_role["domain"] != "sales_exec":
                pairs.append({
                    "resume": f"resume_{r_role['domain']}.txt",
                    "job": f"job_{j_role['domain']}.txt",
                    "expected": "weak",
                    "reason": f"Technical engineering candidate applying to {j_role['title']}",
                })
            elif len(pairs) < 105:
                # Add distinct pairwise negative examples
                existing = any(p["resume"] == f"resume_{r_role['domain']}.txt" and p["job"] == f"job_{j_role['domain']}.txt" for p in pairs)
                if not existing:
                    pairs.append({
                        "resume": f"resume_{r_role['domain']}.txt",
                        "job": f"job_{j_role['domain']}.txt",
                        "expected": "weak",
                        "reason": f"Disparate skill domains ({r_role['domain']} vs {j_role['domain']})",
                    })

    # 3. Write labels.csv
    labels_csv_path = out_path / "labels.csv"
    with open(labels_csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["resume", "job", "expected", "reason"])
        writer.writeheader()
        writer.writerows(pairs)

    print(f"Generated extended evaluation dataset: {len(pairs)} pairs in {out_path}")
    return len(pairs)


if __name__ == "__main__":
    generate_extended_dataset()
