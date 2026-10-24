from bs4 import BeautifulSoup

from app.agent_tools.problem_search import html_to_text
from app.agent_tools.quiz_markup import restore_quiz_widgets

QUESTION = ('<h5 id=65>65</h5><p>考虑一个具有 64 个块且块大小为 16 字节的直接映射缓存。字节地址 1206 会映射到哪个块号（ ）？</p>'
            '<div class="choice-container" data-answer=C id=quiz-65><form>'
            '<label class=choice-option><input type=radio name=c value=A> <span class=choice-label>A.</span> <span class=choice-text>不映射</span></label>'
            '<label class=choice-option><input type=radio name=c value=B> <span class=choice-label>B.</span> <span class=choice-text>6</span></label>'
            '<label class=choice-option><input type=radio name=c value=C> <span class=choice-label>C.</span> <span class=choice-text>11</span></label>'
            '<label class=choice-option><input type=radio name=c value=D> <span class=choice-label>D.</span> <span class=choice-text>54</span></label>'
            '</form><button>查看答案与解析</button></div>'
            '<div class=explanation><p>解析：内存块号 = 1206 / 16 = 75，缓存块号 = 75 mod 64 = 11。</p></div>')


def page(body: str) -> str:
    prose = "<p>高速缓存与主存的地址映射是计算机组成原理中的重点内容，直接映射、全相联和组相联各有特点。</p>" * 6
    return f"<html><body><article>{prose}{body}{prose}</article></body></html>"


def test_radio_options_and_declared_answer_become_plain_lines():
    soup = BeautifulSoup(page(QUESTION), "lxml")
    assert restore_quiz_widgets(soup) == 1
    lines = [p.get_text() for p in soup.select("div.choice-container p")]
    assert lines == ["A. 不映射", "B. 6", "C. 11", "D. 54", "答案：C"]
    assert soup.find("form") is None


def test_options_survive_the_main_content_extractor():
    # trafilatura 把 <form> 当模板丢掉；没有还原时题干后面直接就是解析
    text, _, _ = html_to_text(page(QUESTION))
    assert "A. 不映射" in text and "D. 54" in text
    assert "答案：C" in text
    assert text.index("D. 54") < text.index("解析")


def test_labels_without_letters_get_letters_and_an_unreadable_answer_is_ignored():
    html = ('<div data-answer="见解析"><form><label><input type=checkbox>先进先出</label>'
            '<label><input type=checkbox>后进先出</label></form></div>')
    soup = BeautifulSoup(html, "lxml")
    assert restore_quiz_widgets(soup) == 1
    assert [p.get_text() for p in soup.find_all("p")] == ["A. 先进先出", "B. 后进先出"]


def test_multiple_answers_and_ordinary_forms():
    soup = BeautifulSoup('<div data-answer="A, C"><form><label><input type=checkbox>甲</label>'
                         '<label><input type=checkbox>乙</label><label><input type=checkbox>丙</label></form></div>'
                         '<form><label>邮箱 <input type=text></label><button>订阅</button></form>', "lxml")
    assert restore_quiz_widgets(soup) == 1
    assert [p.get_text() for p in soup.find_all("p")][-1] == "答案：AC"
    assert len(soup.find_all("form")) == 1  # 普通表单不动


def test_main_prompt_tells_the_coordinator_that_threads_can_search_real_problems():
    from app.chat.prompts import MAIN_ROLE_PROMPT

    assert "search_good_problems" in MAIN_ROLE_PROMPT
    assert "不要对用户说「没有联网能力」" in MAIN_ROLE_PROMPT
