const input = '<div class="input-wrap"><textarea>Historical prompt</textarea></div>'
const actions = (send, cancel = 'Cancel') => `<div class="actions"><button data-action="send">${send}</button><button data-action="cancel">${cancel}</button></div>`
const fixture = (id, host, content, attributes = '') => ({ id, host, html: `<article id="edit" ${attributes}>${content}</article>` })

export const editFixtures = [
  fixture('chatgpt', 'chatgpt.com', input + actions('Save &amp; Submit'), 'data-testid="conversation-turn-1"'),
  fixture('claude', 'claude.ai', input + actions('Save'), 'data-testid="user-message"'),
  fixture('gemini', 'gemini.google.com', input + actions('Save'), 'class="query-content"'),
  fixture('doubao', 'www.doubao.com', '<div data-testid="editing_message_content"><div contenteditable="true" data-testid="editing_message_content_input"><span id="nested">Historical prompt</span></div><button data-testid="editing_message_content_confirm" data-action="send">Send</button><button data-testid="editing_message_content_cancel" data-action="cancel">Cancel</button></div>'),
  fixture('chatglm', 'chatglm.cn', input + actions('\u91cd\u65b0\u53d1\u9001', '\u53d6\u6d88'), 'class="conversation question"'),
  fixture('deepseek', 'chat.deepseek.com', input + '<div role="button" class="ds-button ds-button--capsule ds-button--primary ds-button--filled" data-action="send"><span class="ds-button__content">\u53d1\u9001</span></div><div role="button" class="ds-button ds-button--capsule ds-button--outlinedNeutral ds-button--outlined" data-action="cancel"><span class="ds-button__content">\u53d6\u6d88</span></div>'),
  fixture('kimi', 'www.kimi.com', '<div class="editable-segment"><div class="editor-container"><div contenteditable="true" class="re-ask-input"><span id="nested">Historical prompt</span></div></div><div class="button-container"><button class="confirm button" data-action="send">\u786e\u8ba4</button><button class="cancel button" data-action="cancel">\u53d6\u6d88</button></div></div>'),
  fixture('yiyan', 'wenxin.baidu.com', input + actions('\u53d1\u9001', '\u53d6\u6d88'), 'class="cs-rank" data-query="Historical prompt" rank="1"'),
  fixture('qianwen', 'www.qianwen.com', '<div class="question-edit-y9T9Uc">' + input + '<div class="btn-zone-VbqEt5"><div class="secondary-ADUwM0" data-action="send">\u53d1\u9001</div><div class="plain-IuXDOi" data-action="cancel">\u53d6\u6d88</div></div></div>'),
  { id: 'mimo', host: 'aistudio.xiaomimimo.com', native: true, html: '<article id="edit"><div class="dialogue-container">' + input + '<button data-track-id="home_send_btn" data-action="send">Send</button></div></article>' },
]

export const editComposer = '<footer><textarea id="chat-input">New prompt</textarea><button class="compose" data-action="compose">Send</button></footer>'

export const platformComposers = {
  chatgpt: '<footer><textarea id="prompt-textarea" data-composer>New prompt</textarea><button data-testid="send-button" data-action="compose">Send</button></footer>',
  claude: '<footer><div contenteditable="true" role="textbox" data-composer>New prompt</div><button aria-label="Send Message" data-action="compose">Send</button></footer>',
  gemini: '<footer><rich-textarea><textarea data-composer>New prompt</textarea></rich-textarea><button class="send-button" data-action="compose">Send</button></footer>',
  doubao: '<footer><div class="tiptap ProseMirror" contenteditable="true" data-composer>New prompt</div><button data-testid="chat_input_send_button" data-action="compose">Send</button></footer>',
  chatglm: '<footer id="search-input-box"><textarea data-composer>New prompt</textarea><div class="enter"><div class="enter-icon-container" data-action="compose" data-send-event="mousedown">Send</div></div></footer>',
  deepseek: '<footer><textarea id="chat-input" data-composer>New prompt</textarea><div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle" data-action="compose">Arrow</div></footer>',
  kimi: '<footer><div contenteditable="true" data-composer>New prompt</div><div class="send-button-container" data-action="compose">Send</div></footer>',
  yiyan: '<footer><textarea id="chat-textarea" data-composer>New prompt</textarea><img id="ci-submit-button-ai" class="ci-submit-button-ai-active" data-action="compose" alt="Send" style="width:32px;height:32px"></footer>',
  qianwen: '<footer><div data-slate-editor="true" contenteditable="true" data-composer>New prompt</div><button data-session-switch-target="send-query" data-action="compose">Send</button></footer>',
  mimo: '<footer><textarea data-composer>New prompt</textarea><button class="send" data-action="compose">Send</button></footer>',
}
