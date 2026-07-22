// lucide-react 按需导入子路径类型声明
// 通过 lucide-react/dist/esm/icons/<name> 形式导入单图标时，
// 因 lucide-react 未为子路径发布 .d.ts，需声明默认导出类型。
// 类型从 lucide-react 顶层入口的 ForwardRefExoticComponent 复用。
declare module 'lucide-react/dist/esm/icons/*' {
  import type { ForwardRefExoticComponent, SVGProps } from 'react'
  type LucideIcon = ForwardRefExoticComponent<
    Omit<SVGProps<SVGSVGElement>, 'ref'> & {
      size?: number | string
      absoluteStrokeWidth?: boolean
    }
  >
  const Icon: LucideIcon
  export default Icon
}
