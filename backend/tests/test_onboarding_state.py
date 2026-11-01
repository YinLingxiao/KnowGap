from app.chat.skills import select_skill_prompt, ONBOARDING_TITLE


def test_title_does_not_select_skill():
    assert select_skill_prompt('chat', '你好', conversation_title=ONBOARDING_TITLE) is None


def test_user_profile_authority_and_transient_request():
    from app.chat.agent import chat_messages, learning_context, validate_analysis
    messages = chat_messages([], [], None, [], snapshot='USER（本轮开始时的快照）：\n讲解偏好：先举例\n\nMEMORY（本轮开始时的快照）：\n（空）')
    context = learning_context(messages)
    assert context['teaching_preferences'][0]['source'] == 'USER'
    result = validate_analysis({'observations': [{'kind': 'preference', 'topic': '解析',
        'summary': '直接给答案', 'evidence': '这次直接给答案', 'reason': '用户要求'}]}, '这次直接给答案', None, [])
    assert not result['observations']
