"""Canonical native Vertex endpoints; never send ADC tokens to arbitrary hosts."""

import re


def adc_base_url(project: str, location: str) -> str:
    project, location = project.strip(), location.strip()
    if not re.fullmatch(r"(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})", project):
        raise ValueError("Invalid Google Cloud project ID")
    if not re.fullmatch(r"(?:global|[a-z]+(?:-[a-z]+)*[0-9]+)", location):
        raise ValueError("Invalid Google Cloud location")
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}/v1/projects/{project}/locations/{location}/publishers/google/models"
