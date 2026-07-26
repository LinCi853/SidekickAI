import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import 'highlight.js/styles/github.css';
import { formatTime } from '../lib/datetime';
import type { ChatMessage } from '../lib/electron-api';
import { CodeBlock } from './CodeBlock';

/** 单条消息气泡：头像 + 元信息 + 内容（assistant 用 Markdown 渲染） */
export function MessageBubble({
  message,
  streaming,
  providerName,
  showAvatar = true,
  showTimestamp = true,
  onEdit,
  onRetry,
  onContinue,
}: {
  message: ChatMessage;
  streaming?: boolean;
  providerName?: string;
  showAvatar?: boolean;
  showTimestamp?: boolean;
  /** 6.5: 编辑用户消息回调 */
  onEdit?: (msgId: string, newContent: string) => void;
  /** 6.5: 重试上一条 assistant 消息回调 */
  onRetry?: () => void;
  /** 6.5: 继续生成回调 */
  onContinue?: () => void;
}) {
  const isUser = message.role === 'user';
  const avatarText = isUser ? '我' : (providerName?.charAt(0).toUpperCase() || 'AI');

  // 6.5: 编辑态管理
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);

  const handleStartEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    onEdit?.(message.id, editText);
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditText(message.content);
    setIsEditing(false);
  };

  // 6.5: 非流式时显示 hover 操作按钮组
  const showActions = !streaming && (isUser ? !!onEdit : (!!onRetry || !!onContinue));

  return (
    <div className={`chat-msg-row ${message.role}`} data-name="chat.message-bubble.container">
      {showAvatar && <div className={`chat-avatar ${message.role}`} data-name="chat.message-bubble.avatar">{avatarText}</div>}
      <div className="chat-msg-content" data-name="chat.message-bubble.content">
        {(showTimestamp || !showAvatar) && (
          <div className="chat-msg-meta" data-name="chat.message-bubble.meta">
            <span data-name="chat.message-bubble.author">{isUser ? '我' : (providerName || 'AI')}</span>
            {showTimestamp && <span data-name="chat.message-bubble.timestamp">{formatTime(message.createdAt, 'time')}</span>}
          </div>
        )}
        {showActions && (
          <div className="message-actions" data-name="chat.message-bubble.actions">
            {isUser && onEdit && (
              <button type="button" className="btn-outline" data-name="chat.message-bubble.edit-button" onClick={handleStartEdit}>编辑</button>
            )}
            {!isUser && onRetry && (
              <button type="button" className="btn-outline" data-name="chat.message-bubble.retry-button" onClick={onRetry}>重试</button>
            )}
            {!isUser && onContinue && (
              <button type="button" className="btn-outline" data-name="chat.message-bubble.continue-button" onClick={onContinue}>继续</button>
            )}
          </div>
        )}
        {isEditing ? (
          <div className="message-editing" data-name="chat.message-bubble.edit-container">
            <textarea
              data-name="chat.message-bubble.edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="message-editing-actions" data-name="chat.message-bubble.edit-actions">
              <button type="button" className="btn-outline cancel" data-name="chat.message-bubble.edit-cancel-button" onClick={handleCancelEdit}>取消</button>
              <button type="button" className="save" data-name="chat.message-bubble.edit-save-button" onClick={handleSaveEdit}>保存</button>
            </div>
          </div>
        ) : isUser ? (
          <div className={`chat-msg user${streaming ? ' streaming' : ''}`} data-name="chat.message-bubble.user-content">{message.content}</div>
        ) : (
          <div className={`chat-msg assistant${streaming ? ' streaming' : ''}`} data-name="chat.message-bubble.assistant-content">
            <div className="md-body" data-name="chat.message-bubble.markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ children }) => <>{children}</>,
                  code: ({ className: cn, children }) => (
                    <CodeBlock className={cn}>{children}</CodeBlock>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageBubble;
