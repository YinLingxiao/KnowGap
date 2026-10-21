"""Dependency-free RFC 5545 serialization (floating local times, UTF-8 folding)."""

from datetime import date, datetime, timedelta, timezone


def escape(text):
    return text.replace("\\", "\\\\").replace("\r\n", "\n").replace("\r", "\n").replace(
        "\n", "\\n").replace(";", "\\;").replace(",", "\\,")


def fold(line):
    lines, current = [], ""
    for char in line:
        if len((current + char).encode("utf-8")) > 75:
            lines.append(current)
            current = " "
        current += char
    return "\r\n".join([*lines, current])


def calendar(tasks):
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KnowGap//Agenda//ZH", "CALSCALE:GREGORIAN"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for task in tasks:
        title = task["title"]
        if task["scheduled_start_at"]:
            start = datetime.fromisoformat(task["scheduled_start_at"])
            end = start + timedelta(minutes=task["duration_minutes"] or 30)
            timing = ["DTSTART:" + start.strftime("%Y%m%dT%H%M%S"), "DTEND:" + end.strftime("%Y%m%dT%H%M%S")]
        else:
            day = task["scheduled_date"] or task["deadline_date"]
            if not day:
                continue
            start = date.fromisoformat(day)
            timing = ["DTSTART;VALUE=DATE:" + start.strftime("%Y%m%d"),
                      "DTEND;VALUE=DATE:" + (start + timedelta(days=1)).strftime("%Y%m%d")]
            if not task["scheduled_date"]:
                title = "截止：" + title
        lines += ["BEGIN:VEVENT", "UID:" + task["id"] + "@knowgap", "DTSTAMP:" + stamp, *timing,
                  "SUMMARY:" + escape(title), "DESCRIPTION:" + escape(task["notes"]), "END:VEVENT"]
    return ("\r\n".join(fold(line) for line in [*lines, "END:VCALENDAR"]) + "\r\n").encode("utf-8")
