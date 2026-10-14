"""Small, deterministic stack exercise catalogue with checked reference traces."""

from app.models.schemas import Problem


def simulate_stack(inputs: list[int], outputs: list[int]) -> tuple[bool, list[str]]:
    if len(inputs) != len(outputs) or sorted(inputs) != sorted(outputs):
        raise ValueError("Input/output must contain the same unique elements")
    if len(set(inputs)) != len(inputs):
        raise ValueError("MVP exercises require unique elements")
    stack: list[int] = []
    cursor = 0
    trace = []
    for target in outputs:
        while (not stack or stack[-1] != target) and cursor < len(inputs):
            value = inputs[cursor]
            stack.append(value)
            cursor += 1
            trace.append(f"push {value}: {stack}")
        if not stack or stack[-1] != target:
            trace.append(f"blocked: want {target}, top is {stack[-1] if stack else None}")
            return False, trace
        stack.pop()
        trace.append(f"pop {target}: {stack}")
    return True, trace


def make_problem(number: int, inputs: list[int], outputs: list[int]) -> Problem:
    return Problem(
        id=f"stack-sequence-{number:03d}", title=f"栈的出栈序列 · {number}",
        topic_key="stack.lifo", input_sequence=inputs, output_sequence=outputs,
        prompt=(f"元素按 {inputs} 的顺序入栈，入栈与出栈操作可以交替进行。"
                f"能否得到出栈序列 {outputs}？请说明理由或列出操作过程。"),
    )


PROBLEMS = {
    p.id: p for p in (
        make_problem(1, [1, 2, 3], [3, 1, 2]),
        make_problem(2, [1, 2, 3, 4], [2, 4, 1, 3]),
        make_problem(3, [1, 2, 3, 4], [2, 1, 4, 3]),
    )
}


def reference_for(problem: Problem) -> dict:
    possible, trace = simulate_stack(problem.input_sequence, problem.output_sequence)
    return {
        "possible": possible, "trace": trace,
        "rubric": "检查每一次弹出的元素是否为当时的栈顶；仅判断元素集合相同不充分。",
    }
