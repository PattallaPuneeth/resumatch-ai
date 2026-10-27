import re

from ml.models.resume import (
    ContactInfo,
    EducationItem,
    ExperienceItem,
    FieldConfidence,
    SkillItem,
    SourceSpan,
)

# Standard Skill Catalog categorized per specification
SKILL_CATALOG: dict[str, list[str]] = {
    "languages": [
        "Python",
        "TypeScript",
        "JavaScript",
        "Java",
        "C++",
        "C#",
        "Go",
        "Golang",
        "Rust",
        "Ruby",
        "PHP",
        "Swift",
        "Kotlin",
        "Scala",
        "R",
        "SQL",
        "HTML",
        "CSS",
        "Bash",
        "Shell",
        "PowerShell",
        "Perl",
        "Dart",
    ],
    "frameworks": [
        "React",
        "Next.js",
        "Vue",
        "Angular",
        "Node.js",
        "Express",
        "Fastify",
        "FastAPI",
        "Django",
        "Flask",
        "Spring Boot",
        "ASP.NET",
        "Rails",
        "NestJS",
        "Svelte",
        "TailwindCSS",
        "Bootstrap",
        "PyTorch",
        "TensorFlow",
        "Keras",
        "Scikit-Learn",
        "Pandas",
        "NumPy",
    ],
    "tools": [
        "Docker",
        "Kubernetes",
        "Git",
        "GitHub",
        "GitLab",
        "AWS",
        "Azure",
        "GCP",
        "Google Cloud",
        "PostgreSQL",
        "Postgres",
        "MySQL",
        "MongoDB",
        "Redis",
        "MinIO",
        "Kafka",
        "RabbitMQ",
        "Linux",
        "Nginx",
        "Terraform",
        "Ansible",
        "Jenkins",
        "CircleCI",
        "Elasticsearch",
        "GraphQL",
        "REST",
        "Jira",
        "Tesseract",
        "BullMQ",
    ],
    "soft_skills": [
        "Leadership",
        "Communication",
        "Problem Solving",
        "Teamwork",
        "Mentorship",
        "Agile",
        "Scrum",
        "Critical Thinking",
        "Project Management",
        "Collaboration",
        "Time Management",
        "Adaptability",
    ],
}

# Catalog entries that collide with common English words or initials when matched
# case-insensitively. These must appear with the catalog's casing to count as a skill.
CASE_SENSITIVE_SKILLS: frozenset[str] = frozenset(
    {"Go", "R", "Rust", "Ruby", "Swift", "Dart", "Shell", "Perl", "Express", "REST", "Rails"}
)

EMAIL_REGEX = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b")
PHONE_REGEX = re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
LINKEDIN_REGEX = re.compile(
    r"(?:https?://)?(?:www\.)?linkedin\.com/in/([A-Za-z0-9_-]+)", re.IGNORECASE
)
GITHUB_REGEX = re.compile(r"(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9_-]+)", re.IGNORECASE)

SECTION_HEADERS: dict[str, list[str]] = {
    "summary": ["summary", "professional summary", "about me", "profile", "objective"],
    "skills": ["skills", "technical skills", "core competencies", "technologies", "key skills"],
    "experience": [
        "experience",
        "work experience",
        "professional experience",
        "employment history",
        "work history",
    ],
    "education": ["education", "academic background", "academic history", "qualifications"],
    "certifications": ["certifications", "certificates", "licenses"],
}


def _find_sections(text: str) -> dict[str, tuple[int, int]]:
    """Locate header start and end offsets for common resume sections."""
    sections: dict[str, tuple[int, int]] = {}
    lines = text.split("\n")
    header_indices: list[tuple[str, int]] = []

    current_offset = 0
    for line in lines:
        cleaned_line = line.strip().lower()
        cleaned_line_alpha = re.sub(r"[^a-z\s]", "", cleaned_line).strip()
        for sec_name, keywords in SECTION_HEADERS.items():
            if cleaned_line_alpha in keywords and len(cleaned_line_alpha) > 2:
                header_indices.append((sec_name, current_offset))
                break
        current_offset += len(line) + 1  # accounts for newline

    for i, (sec_name, start_idx) in enumerate(header_indices):
        end_idx = header_indices[i + 1][1] if i + 1 < len(header_indices) else len(text)
        sections[sec_name] = (start_idx, end_idx)

    return sections


def extract_contact_info(raw_text: str) -> tuple[ContactInfo, str | None]:
    """Extract contact details and candidate name with exact canonical text spans."""
    contact = ContactInfo()
    candidate_name: str | None = None

    # 1. Email
    email_match = EMAIL_REGEX.search(raw_text)
    if email_match:
        start, end = email_match.start(), email_match.end()
        contact.email = email_match.group()
        contact.email_confidence = FieldConfidence(
            score=0.99,
            source_span=SourceSpan(start_char=start, end_char=end, source_text=raw_text[start:end]),
        )

    # 2. Phone
    phone_match = PHONE_REGEX.search(raw_text)
    if phone_match:
        start, end = phone_match.start(), phone_match.end()
        contact.phone = phone_match.group()
        contact.phone_confidence = FieldConfidence(
            score=0.95,
            source_span=SourceSpan(start_char=start, end_char=end, source_text=raw_text[start:end]),
        )

    # 3. LinkedIn
    linkedin_match = LINKEDIN_REGEX.search(raw_text)
    if linkedin_match:
        contact.linkedin_url = linkedin_match.group()

    # 4. GitHub
    github_match = GITHUB_REGEX.search(raw_text)
    if github_match:
        contact.github_url = github_match.group()

    # 5. Candidate Name (heuristic: first non-empty line of the resume before contacts/sections)
    lines = [ln.strip() for ln in raw_text.split("\n") if ln.strip()]
    for line in lines[:4]:
        # Filter out email, phone, URLs, or section headers
        if (
            not EMAIL_REGEX.search(line)
            and not PHONE_REGEX.search(line)
            and not LINKEDIN_REGEX.search(line)
            and not GITHUB_REGEX.search(line)
            and len(line) < 50
            and re.match(r"^[A-Za-z\s.'-]+$", line)
        ):
            candidate_name = line
            idx = raw_text.find(line)
            if idx != -1:
                contact.name = candidate_name
                contact.name_confidence = FieldConfidence(
                    score=0.90,
                    source_span=SourceSpan(
                        start_char=idx,
                        end_char=idx + len(line),
                        source_text=raw_text[idx : idx + len(line)],
                    ),
                )
            break

    return contact, candidate_name


def extract_skills(raw_text: str, sections: dict[str, tuple[int, int]]) -> list[SkillItem]:
    """Extract categorized skills with exact canonical character spans."""
    skills: list[SkillItem] = []
    seen_skills: set[str] = set()

    skills_sec_span = sections.get("skills")

    for category, skill_list in SKILL_CATALOG.items():
        for skill_name in skill_list:
            # Word boundary regex for exact matching (handling C++, C#, .NET etc.)
            escaped = re.escape(skill_name)
            pattern = rf"(?<!\w){escaped}(?![\w&])"
            # Names that are also everyday English words ("go", "swift", "rest", "shell") or a
            # single letter ("R" in "R&D") only count when written with their exact casing.
            flags = 0 if skill_name in CASE_SENSITIVE_SKILLS else re.IGNORECASE
            matches = list(re.finditer(pattern, raw_text, flags))
            if not matches:
                continue

            # Pick the best occurrence (prefer inside skills section if available)
            chosen_match = matches[0]
            in_skills_section = False
            if skills_sec_span:
                sec_start, sec_end = skills_sec_span
                for m in matches:
                    if sec_start <= m.start() < sec_end:
                        chosen_match = m
                        in_skills_section = True
                        break

            norm_name = skill_name.lower()
            if norm_name in seen_skills:
                continue
            seen_skills.add(norm_name)

            start, end = chosen_match.start(), chosen_match.end()
            confidence = 0.98 if in_skills_section else 0.85

            skills.append(
                SkillItem(
                    name=skill_name,
                    category=category,
                    confidence=FieldConfidence(
                        score=confidence,
                        source_span=SourceSpan(
                            start_char=start,
                            end_char=end,
                            source_text=raw_text[start:end],
                        ),
                    ),
                )
            )

    return skills


def extract_experience(raw_text: str, sections: dict[str, tuple[int, int]]) -> list[ExperienceItem]:
    """Extract work experience entries from canonical text with character spans."""
    items: list[ExperienceItem] = []
    exp_span = sections.get("experience")
    if not exp_span:
        return items

    sec_start, sec_end = exp_span
    exp_text = raw_text[sec_start:sec_end]
    lines = exp_text.split("\n")

    # Group lines by paragraphs/entries
    current_entry_lines: list[str] = []
    current_bullets: list[str] = []

    def flush_entry() -> None:
        if not current_entry_lines:
            return
        header_text = current_entry_lines[0].strip()
        # Look for company/title separators: ' at ', ' - ', ' | ', ','
        parts = re.split(r"\s+(?:at|-|\|)\s+", header_text)
        title = parts[0].strip() if parts else "Role"
        company = parts[1].strip() if len(parts) > 1 else (parts[0] if parts else "Company")

        # Find position of entry in raw_text
        start_idx = raw_text.find(header_text, sec_start, sec_end)
        end_idx = start_idx + len(header_text) if start_idx != -1 else sec_start + 1

        items.append(
            ExperienceItem(
                company=company,
                title=title,
                bullets=current_bullets.copy(),
                confidence=FieldConfidence(
                    score=0.88,
                    source_span=SourceSpan(
                        start_char=start_idx if start_idx != -1 else sec_start,
                        end_char=end_idx,
                        source_text=raw_text[start_idx:end_idx] if start_idx != -1 else header_text,
                    ),
                ),
            )
        )

    for line in lines[1:]:  # skip the section title line
        stripped = line.strip()
        if not stripped:
            continue
        # Bullet detection
        if stripped.startswith(("-", "*", "•", "–")) or re.match(r"^\d+\.", stripped):
            clean_bullet = re.sub(r"^[-*•–\d.]\s*", "", stripped)
            current_bullets.append(clean_bullet)
        elif len(stripped) < 70 and not current_bullets:
            current_entry_lines.append(stripped)
        elif len(stripped) < 70 and current_bullets:
            flush_entry()
            current_entry_lines = [stripped]
            current_bullets = []
        else:
            current_bullets.append(stripped)

    flush_entry()
    return items


def extract_education(raw_text: str, sections: dict[str, tuple[int, int]]) -> list[EducationItem]:
    """Extract education entries with character spans."""
    items: list[EducationItem] = []
    edu_span = sections.get("education")
    if not edu_span:
        return items

    sec_start, sec_end = edu_span
    edu_text = raw_text[sec_start:sec_end]
    lines = [ln.strip() for ln in edu_text.split("\n") if ln.strip()]

    degree_keywords = [
        "bachelor",
        "master",
        "phd",
        "b.s",
        "b.a",
        "m.s",
        "m.a",
        "b.tech",
        "m.tech",
        "degree",
        "diploma",
        "associate",
    ]

    for line in lines[1:]:  # skip section title line
        start_idx = raw_text.find(line, sec_start, sec_end)
        end_idx = start_idx + len(line) if start_idx != -1 else sec_start + len(line)

        # Detect degree vs institution
        is_degree = any(dk in line.lower() for dk in degree_keywords)
        institution = line if not is_degree else "University / Institution"
        degree = line if is_degree else None

        # Look for 4-digit graduation year
        year_match = re.search(r"\b(19\d{2}|20\d{2})\b", line)
        grad_year = int(year_match.group()) if year_match else None

        items.append(
            EducationItem(
                institution=institution,
                degree=degree,
                graduation_year=grad_year,
                confidence=FieldConfidence(
                    score=0.85,
                    source_span=SourceSpan(
                        start_char=start_idx if start_idx != -1 else sec_start,
                        end_char=end_idx,
                        source_text=raw_text[start_idx:end_idx] if start_idx != -1 else line,
                    ),
                ),
            )
        )

    return items
