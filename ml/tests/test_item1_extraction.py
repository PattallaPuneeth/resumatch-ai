from ml.scoring.item1_extraction import assess_software_it_skills


def test_it_skill_extraction_tracks_exact_spans_cues_and_list_context():
    jd = """Requirements:
- Python required
- Kubernetes required
Preferred:
- AWS is a plus
"""
    resume = """Technical Skills
Python, AWS
Experience
Built a Kubernetes platform.
"""
    result = assess_software_it_skills(resume, jd)
    units = {unit["skill"]: unit for unit in result["units"]}
    assert units["Python"]["cue"] == "Required"
    assert units["Python"]["credit"] == 0.8
    assert units["Python"]["context"] == "skills_list"
    assert units["Kubernetes"]["credit"] == 1.0
    assert resume[units["Kubernetes"]["start"] : units["Kubernetes"]["end"]] == "Kubernetes"
    assert units["Amazon Web Services"]["cue"] == "Preferred"
    assert units["Amazon Web Services"]["credit"] == 0.8
    assert result["score"] == 88


def test_k8s_alias_is_exact_evidence_for_kubernetes():
    result = assess_software_it_skills(
        "Experience\nDeployed services on K8s.",
        "Requirements:\nKubernetes required",
    )
    unit = next(u for u in result["units"] if u["skill"] == "Kubernetes")
    assert unit["credit"] == 1.0
    assert unit["evidence"] == "K8s"


def test_java_does_not_match_javascript():
    result = assess_software_it_skills(
        "Experience\nBuilt web interfaces in JavaScript.",
        "Requirements:\nJava required",
    )
    unit = next(u for u in result["units"] if u["skill"] == "Java")
    assert unit["credit"] == 0.0


def test_new_section_heading_resets_inherited_cue():
    result = assess_software_it_skills(
        "Experience\nBuilt Python services and deployed AWS infrastructure.",
        "Requirements:\n- Python\nOther details:\n- AWS",
    )
    units = {unit["skill"]: unit for unit in result["units"]}
    assert units["Python"]["cue"] == "Required"
    assert units["Amazon Web Services"]["cue"] == "Unlabelled"


def test_negated_or_learning_mentions_do_not_receive_skill_credit():
    result = assess_software_it_skills(
        "Experience\nNo experience with Python. Currently learning Kubernetes.",
        "Requirements:\nPython\nKubernetes",
    )
    units = {unit["skill"]: unit for unit in result["units"]}
    assert units["Python"]["status"] == "Possible"
    assert units["Python"]["credit"] == 0.0
    assert units["Kubernetes"]["status"] == "Possible"
    assert units["Kubernetes"]["credit"] == 0.0


def test_unrelated_distant_negation_does_not_cancel_skill_evidence():
    result = assess_software_it_skills(
        "Experience\nI did not use old tooling. Our team built production services with Python.",
        "Requirements:\nPython required",
    )
    unit = next(u for u in result["units"] if u["skill"] == "Python")
    assert unit["credit"] == 1.0


def test_required_qualifications_heading_governs_bullets():
    result = assess_software_it_skills(
        "Experience\nBuilt Python services.",
        "Required Qualifications:\n- Python",
    )
    unit = next(u for u in result["units"] if u["skill"] == "Python")
    assert unit["cue"] == "Required"


def test_stuffing_guard_reduces_required_list_only_credit_to_half():
    result = assess_software_it_skills(
        "Technical Skills\nPython, Java, Docker, Kubernetes",
        "Required Skills:\n- Python\n- Java\n- Docker\n- Kubernetes\n- React",
    )
    list_units = [u for u in result["units"] if u["cue"] == "Required" and u["credit"] > 0]
    assert result["stuffing_guard_applied"] is True
    assert len(list_units) == 4
    assert all(unit["credit"] == 0.5 for unit in list_units)


def test_stuffing_guard_does_not_apply_when_role_evidence_exists():
    result = assess_software_it_skills(
        "Technical Skills\nPython, Java, Docker\nExperience\nBuilt Kubernetes services.",
        "Required Skills:\n- Python\n- Java\n- Docker\n- Kubernetes\n- React",
    )
    assert result["stuffing_guard_applied"] is False


def test_conflicting_required_and_preferred_cues_become_unlabelled():
    result = assess_software_it_skills(
        "Experience\nBuilt Python services.",
        "Required Skills:\n- Python\nPreferred Skills:\n- Python",
    )
    unit = next(u for u in result["units"] if u["skill"] == "Python")
    assert unit["cue"] == "Unlabelled"
