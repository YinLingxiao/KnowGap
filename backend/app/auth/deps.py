from contextvars import ContextVar, Token

from app.models.schemas import DEMO_STUDENT

_student: ContextVar[str] = ContextVar("knowgap_student", default=DEMO_STUDENT)


def current_student() -> str:
    return _student.get()


def set_student(student_id: str) -> Token:
    return _student.set(student_id)


def reset_student(token: Token) -> None:
    _student.reset(token)
