/* =====================================================================
   components/AiAppEditorModal/PopupWhitelistSection.tsx —— 弹窗白名单编辑区
   纯展示组件：应用专属弹窗白名单列表与新增输入（Profile 专属，应用关联域隔离）。
   白名单状态与提示回调均由父组件（components/AiAppEditorModal.tsx）传入。
   ===================================================================== */

import type { Dispatch, SetStateAction } from 'react';
import Button from '../ui/Button';
import { FieldGroup } from './FieldGroup';

export interface PopupWhitelistSectionProps {
  popupWhitelist: string[];
  setPopupWhitelist: Dispatch<SetStateAction<string[]>>;
  whitelistInput: string;
  setWhitelistInput: Dispatch<SetStateAction<string>>;
  showToast: (msg: string) => void;
}

export function PopupWhitelistSection({
  popupWhitelist,
  setPopupWhitelist,
  whitelistInput,
  setWhitelistInput,
  showToast,
}: PopupWhitelistSectionProps) {
  return (
    <>
      <FieldGroup
        label="弹窗白名单（应用专属）"
        hint="允许这些域名弹独立窗口（登录/验证页等）。内置默认登录域已自动合并，此处只需配置本应用额外的关联域。"
      >
        <div className="ai-app-editor-whitelist" data-name="ai-app-editor.popup-whitelist-container">
          {popupWhitelist.length === 0 && (
            <div className="ai-app-editor-empty" data-name="ai-app-editor.popup-whitelist-empty">
              暂无应用专属白名单（依赖内置默认登录域兜底）
            </div>
          )}
          {popupWhitelist.map((origin, wIdx) => (
            <div
              key={wIdx}
              className="ai-app-editor-rule-item"
              data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}`}
            >
              <span className="ai-app-editor-rule-label" data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-text`}>
                {origin}
              </span>
              <Button
                variant="text"
                danger
                className="btn-secondary-underline danger"
                onClick={() => setPopupWhitelist((prev) => prev.filter((_, i) => i !== wIdx))}
                data-name={`ai-app-editor.popup-whitelist-item-${wIdx + 1}-delete-button`}
              >
                删除
              </Button>
            </div>
          ))}

          <div className="ai-app-editor-whitelist-add" data-name="ai-app-editor.popup-whitelist-add">
            <input
              type="text"
              className="ai-editor-input"
              value={whitelistInput}
              onChange={(e) => setWhitelistInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const v = whitelistInput.trim();
                  if (v && !popupWhitelist.includes(v)) {
                    setPopupWhitelist((prev) => [...prev, v]);
                    setWhitelistInput('');
                  }
                }
              }}
              placeholder="https://example.com/"
              data-name="ai-app-editor.popup-whitelist-input"
            />
            <Button
              variant="outline"
              onClick={() => {
                const v = whitelistInput.trim();
                if (!v) return;
                if (popupWhitelist.includes(v)) {
                  showToast('该域名已在白名单中');
                  return;
                }
                setPopupWhitelist((prev) => [...prev, v]);
                setWhitelistInput('');
              }}
              data-name="ai-app-editor.popup-whitelist-add-button"
            >
              添加
            </Button>
          </div>
        </div>
      </FieldGroup>
    </>
  );
}
