import io

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from app.config import Settings
from app.main import create_app
from app.models.schemas import TutorOutput


def config(tmp_path):
    return Settings(_env_file=None, database_path=tmp_path / 'course.sqlite3',
                    llm_api_key='', llm_base_url='', llm_model='')


def upload(client, text='栈遵循后进先出，只能访问栈顶。\nLIFO means last in first out.', filename='lecture.md'):
    return client.post('/api/materials', files={'file': (filename, text.encode('utf-8'), 'text/plain')})


def pdf_bytes():
    writer = PdfWriter()
    for content in ['Queue follows FIFO.', 'Stack follows LIFO, last in first out.']:
        page = writer.add_blank_page(width=300, height=200)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(f'BT /F1 12 Tf 20 100 Td ({content}) Tj ET'.encode())
        page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO(); writer.write(output)
    return output.getvalue()


def test_chinese_english_search_restart_and_delete(tmp_path):
    settings = config(tmp_path)
    with TestClient(create_app(settings)) as client:
        document = upload(client).json()
        upload(client, '太阳与行星的运动。', 'astronomy.txt')
        chinese = client.get('/api/materials/search', params={'q': '后进先出'}).json()
        assert len(chinese) == 1 and chinese[0]['document_id'] == document['id']
        assert chinese[0]['start_line'] == 1 and chinese[0]['end_line'] == 2
        assert 'LIFO' in chinese[0]['excerpt']
        assert client.get('/api/materials/search', params={'q': 'LIFO'}).json()[0]['id'] == chinese[0]['id']
        assert client.get('/api/materials/search', params={'q': '栈'}).json()
        assert client.get('/api/materials/search', params={'q': 'nonexistent'}).json() == []
        assert client.get('/api/materials/search', params={'q': '" OR * ; DROP TABLE course_materials;'}).status_code == 200
        assert len(client.get('/api/materials').json()) == 2
    with TestClient(create_app(settings)) as client:
        assert len(client.get('/api/materials').json()) == 2
        assert client.delete('/api/materials/' + document['id']).status_code == 204
        assert client.get('/api/materials/search', params={'q': 'LIFO'}).json() == []
        assert client.delete('/api/materials/' + document['id']).status_code == 404


def test_pdf_has_correct_page_and_text(tmp_path):
    with TestClient(create_app(config(tmp_path))) as client:
        response = client.post('/api/materials', files={'file': ('lecture.pdf', pdf_bytes(), 'application/pdf')})
        assert response.status_code == 201
        assert response.json()['page_count'] == 2
        results = client.get('/api/materials/search', params={'q': 'LIFO'}).json()
        assert len(results) == 1 and results[0]['page'] == 2
        assert results[0]['start_line'] is None and 'Stack follows LIFO' in results[0]['excerpt']


@pytest.mark.parametrize('filename,data,status', [
    ('a.exe', b'code', 415), ('a.pdf', b'broken', 422), ('a.txt', b'', 422),
    ('a.txt', b'\xff\xfeinvalid', 422), ('a.txt', b'x' * (5 * 1024 * 1024 + 1), 413),
    ('a.txt', b'x' * 200_001, 413),
], ids=['unsupported-extension', 'broken-pdf', 'empty-text', 'invalid-encoding', 'too-many-bytes', 'too-many-characters'])
def test_invalid_upload_never_indexes(tmp_path, filename, data, status):
    with TestClient(create_app(config(tmp_path))) as client:
        assert client.post('/api/materials', files={'file': (filename, data)}).status_code == status
        assert client.get('/api/materials').json() == []


def test_blank_pdf_and_identity_rejected(tmp_path):
    writer = PdfWriter(); writer.add_blank_page(100, 100)
    output = io.BytesIO(); writer.write(output)
    with TestClient(create_app(config(tmp_path))) as client:
        assert client.post('/api/materials', files={'file': ('scan.pdf', output.getvalue())}).status_code == 422
        assert client.get('/api/materials', params={'student_id': 'someone-else'}).status_code == 422
        assert client.get('/api/materials/search', params={'q': 'x', 'limit': 50}).status_code == 422


class SourceTutor:
    def __init__(self, invalid=False, remove=None):
        self.contexts = []
        self.invalid = invalid
        self.remove = remove

    async def generate(self, context):
        self.contexts.append(context)
        sources = context['course_sources']
        if self.remove:
            self.remove(sources[0]['document_id'])
        ids = ['invented'] if self.invalid else [sources[0]['id']] if sources else []
        return TutorOutput(assessment='incorrect', issue='未检查栈顶', confidence=.9,
                           evidence=context['current_answer'], reply='请检查栈顶。[资料1]' if sources else '请检查栈顶。', citation_ids=ids)


def test_teaching_citation_recovery_and_deleted_history_snapshot(tmp_path):
    settings = config(tmp_path); tutor = SourceTutor()
    with TestClient(create_app(settings, tutor)) as client:
        document = upload(client).json()
        response = client.post('/api/diagnosis', json={'problem_id': 'stack-sequence-001', 'answer': '合法，因为数字相同。'})
        assert response.status_code == 200
        result = response.json(); session_id = result['session_id']
        assert len(result['sources']) == 1 and result['sources'][0]['title'] == 'lecture.md'
        assert tutor.contexts[0]['reference']['possible'] is False
        assert '只能访问栈顶' in tutor.contexts[0]['course_sources'][0]['excerpt']
        assert client.get('/api/sessions/' + session_id).json()['messages'][1]['sources'] == result['sources']
        assert client.delete('/api/materials/' + document['id']).status_code == 204
    with TestClient(create_app(settings, tutor)) as client:
        snapshot = client.get('/api/sessions/' + session_id).json()
        assert snapshot['messages'][1]['sources'] == result['sources']
        followup = client.post('/api/sessions/' + session_id + '/messages', json={'content': '我不确定。'})
        assert followup.json()['sources'] == []


def test_invented_citation_rolls_back(tmp_path):
    with TestClient(create_app(config(tmp_path), SourceTutor(invalid=True))) as client:
        upload(client)
        response = client.post('/api/diagnosis', json={'problem_id': 'stack-sequence-001', 'answer': '合法'})
        assert response.status_code == 502 and client.get('/api/memories').json() == []
        with client.app.state.store.connection() as db:
            assert db.execute('SELECT COUNT(*) FROM learning_sessions').fetchone()[0] == 0


def test_deleted_during_generation_conflicts(tmp_path):
    tutor = SourceTutor()
    with TestClient(create_app(config(tmp_path), tutor)) as client:
        upload(client)
        tutor.remove = lambda document_id: client.app.state.materials.delete(document_id, 'demo-student-001')
        response = client.post('/api/diagnosis', json={'problem_id': 'stack-sequence-001', 'answer': '合法'})
        assert response.status_code == 409 and client.get('/api/memories').json() == []


def test_size_bytes_round_trips_in_list_response(tmp_path):
    with TestClient(create_app(config(tmp_path))) as client:
        text = '栈遵循后进先出，只能访问栈顶。\nLIFO means last in first out.'
        document = upload(client, text).json()
        assert document['size_bytes'] == len(text.encode('utf-8'))
        listed = client.get('/api/materials').json()
        assert listed[0]['size_bytes'] == document['size_bytes']


def test_outline_endpoint_returns_headings_and_is_owner_scoped(tmp_path):
    with TestClient(create_app(config(tmp_path))) as client:
        document = upload(client, '# 第一章\n内容。\n# 第二章\n更多内容。', 'notes.md').json()
        response = client.get(f"/api/materials/{document['id']}/outline")
        assert response.status_code == 200
        assert response.json()['outline'] == ['第一章', '第二章']
        assert client.get('/api/materials/unknown-id/outline').status_code == 404
        assert client.get(f"/api/materials/{document['id']}/outline",
                          params={'student_id': 'someone-else'}).status_code == 422


def test_unbound_inline_citation_is_rejected(tmp_path):
    class UnboundTutor:
        async def generate(self, context):
            return TutorOutput(assessment='incorrect', issue='未检查栈顶', confidence=.8,
                evidence=context['current_answer'], reply='参考[资料99]。', citation_ids=[])
    with TestClient(create_app(config(tmp_path), UnboundTutor())) as client:
        upload(client)
        response = client.post('/api/diagnosis', json={'problem_id': 'stack-sequence-001', 'answer': '合法'})
        assert response.status_code == 502 and client.get('/api/memories').json() == []
