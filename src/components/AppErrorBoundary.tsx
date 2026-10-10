// src/components/AppErrorBoundary.tsx —— 根级渲染错误边界
//
// 两层用途：
//   1. main.tsx 包裹 <App/>：App 自身渲染抛错时显示兜底 UI（而非无提示白屏）；
//   2. 复杂窗口内的局部边界（如进阶面板各 tab）：单个重组件（白板/聊天流）崩溃
//      只影响所在区域，不拖垮窗口内其余标签与页面状态。
import { Component, type ReactNode } from 'react';
import { Button } from './ui';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error('[ErrorBoundary] 捕获渲染错误:', error, info.componentStack);
  }
  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-name="app.error-boundary.container" style={{ padding: 'var(--space-6)', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <h3 data-name="app.error-boundary.title" style={{ marginBottom: 'var(--space-2)' }}>页面渲染出错</h3>
          <p data-name="app.error-boundary.message" style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-base)', marginBottom: 'var(--space-4)', wordBreak: 'break-word' }}>
            {this.state.error?.message || '未知错误'}
          </p>
          <Button
            data-name="app.error-boundary.retry-button"
            variant="ghost"
            onClick={() => this.setState({ hasError: false, error: undefined })}
          >
            重试
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default AppErrorBoundary;
