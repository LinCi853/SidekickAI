// electron/freeze/text-layer.ts — 冻结前页面文本层提取
//
// 从 freeze-manager.ts 拆分的文本层逻辑：
//   - GLYPH_EXTRACT_SCRIPT：字符边界提取脚本（主路径，executeJavaScript 执行）
//   - extractTextLayer：主路径（grapheme + 视觉行）+ DOMSnapshot textBoxes 降级路径
//   - isTextLayerCurrent：校验提取结果是否仍与当前页面几何/滚动一致

import { type WebContents } from 'electron'
import type {
  TextLayer,
  TextLayerItem,
} from '../shared/api/freeze.api.js'
import { attach } from './debugger-session.js'

export type { TextLayer, TextLayerItem }

/** 文本层上限（防真实 AI 页面超大 DOM 导致 IPC 传输失败） */
const TEXT_LAYER_MAX_ITEMS = 5000
const TEXT_LAYER_MAX_GRAPHEMES = 50000

/**
 * 字符边界提取脚本（主路径，冻结前 executeJavaScript 执行）：
 *   - Intl.Segmenter 按 grapheme cluster 切分文本
 *   - 每个 grapheme 用 Range.getClientRects() 获取 guest 视口真实边界
 *   - 按视觉行聚合为 run，渲染层只据此绘制原位半透明高亮
 */
export const GLYPH_EXTRACT_SCRIPT = String.raw`(async function() {
  try {
    var MAX = ${TEXT_LAYER_MAX_ITEMS}
    var MAX_GRAPHEMES = ${TEXT_LAYER_MAX_GRAPHEMES}
    try {
      if (document.fonts) {
        await Promise.race([document.fonts.ready, new Promise(function(r) { setTimeout(r, 800) })])
      }
    } catch (_) {}
    var vv = window.visualViewport
    var revisionState = window.__sidekickFreezeGeometryState
    if (!revisionState) {
      revisionState = { revision: 0 }
      var bumpRevision = function() { revisionState.revision++ }
      new MutationObserver(bumpRevision).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
      })
      document.addEventListener('scroll', bumpRevision, true)
      window.addEventListener('resize', bumpRevision)
      window.__sidekickFreezeGeometryState = revisionState
    }
    var documentRevision = revisionState.revision
    var visualOffsetX = vv ? vv.offsetLeft || 0 : 0
    var visualOffsetY = vv ? vv.offsetTop || 0 : 0
    var scrollX = vv ? vv.pageLeft || 0 : (window.scrollX || document.documentElement.scrollLeft || 0)
    var scrollY = vv ? vv.pageTop || 0 : (window.scrollY || document.documentElement.scrollTop || 0)
    var items = []
    var nestedScrollRegions = []
    var nestedScrollElements = new Set()
    var graphemeCount = 0
    var truncated = false
    var lineNo = 0
    var visualLines = []
    var previousBlock = null
    var diagnostics = {
      textNodes: 0,
      nonEmptyTextNodes: 0,
      hiddenByStyle: 0,
      hiddenByClip: 0,
      transparentText: 0,
      noClientRects: 0,
      outsideVisibleClip: 0,
      acceptedGraphemes: 0
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    var n
    var segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
    function getBlock(el) {
      var cur = el
      while (cur && cur !== document.body) {
        var display = getComputedStyle(cur).display
        if (/^(block|list-item|table|table-row|flex|grid|flow-root)$/.test(display)) return cur
        cur = cur.parentElement
      }
      return document.body
    }
    function followsBreak(node) {
      var cur = node
      while (cur && cur !== document.body) {
        var prev = cur.previousSibling
        while (prev && prev.nodeType === Node.TEXT_NODE && !(prev.nodeValue || '').trim()) prev = prev.previousSibling
        if (prev) return prev.nodeType === Node.ELEMENT_NODE && prev.tagName === 'BR'
        cur = cur.parentNode
      }
      return false
    }
    function rectIntersection(a, b) {
      var left = Math.max(a.left, b.left)
      var top = Math.max(a.top, b.top)
      var right = Math.min(a.right, b.right)
      var bottom = Math.min(a.bottom, b.bottom)
      return right > left && bottom > top ? { left: left, top: top, right: right, bottom: bottom } : null
    }
    function inspectAncestors(el) {
      var result = {
        hidden: false,
        transformed: false,
        viewportFixed: false,
        sticky: false,
        clip: { left: visualOffsetX, top: visualOffsetY, right: visualOffsetX + (vv ? vv.width : window.innerWidth), bottom: visualOffsetY + (vv ? vv.height : window.innerHeight) }
      }
      var ancestor = el
      while (ancestor && ancestor.nodeType === Node.ELEMENT_NODE) {
        var style = getComputedStyle(ancestor)
        var opacity = Number(style.opacity)
        // Selection is implemented by the host overlay, so pointer-events/user-select
        // and visual masks must not exclude otherwise visible HTML text.
        if (style.display === 'none' || style.visibility !== 'visible'
          || style.contentVisibility === 'hidden' || (Number.isFinite(opacity) && opacity <= 0.01)
          || ancestor.getAttribute('aria-hidden') === 'true' || ancestor.hasAttribute('hidden')) {
          result.hidden = true
          break
        }
        if (style.transform !== 'none') result.transformed = true
        if (style.position === 'fixed') result.viewportFixed = true
        if (style.position === 'sticky') result.sticky = true
        var clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX)
        var clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY)
        var rootElement = ancestor === document.body || ancestor === document.documentElement
        if ((clipsX || clipsY) && !rootElement) {
          var box = ancestor.getBoundingClientRect()
          var clipBox = {
            left: clipsX ? box.left : result.clip.left,
            top: clipsY ? box.top : result.clip.top,
            right: clipsX ? box.right : result.clip.right,
            bottom: clipsY ? box.bottom : result.clip.bottom
          }
          result.clip = rectIntersection(result.clip, clipBox)
          if (!result.clip) { result.hidden = true; result.clipped = true; break }
          if ((ancestor.scrollHeight > ancestor.clientHeight + 1 || ancestor.scrollWidth > ancestor.clientWidth + 1)
            && ancestor !== document.documentElement && ancestor !== document.body && !nestedScrollElements.has(ancestor)) {
            nestedScrollElements.add(ancestor)
            nestedScrollRegions.push({
              x: box.left - visualOffsetX,
              y: box.top - visualOffsetY,
              w: box.width,
              h: box.height,
              viewportFixed: result.viewportFixed
            })
          }
        }
        ancestor = ancestor.parentElement
      }
      return result
    }
    function rectIsVisible(rect, info) {
      // elementFromPoint is not a reliable text visibility oracle: event-capture
      // overlays and non-interactive wrappers can cover selectable glyphs.
      return Boolean(rectIntersection(info.clip, rect))
    }
    function colorIsTransparent(value) {
      if (!value) return false
      if (value === 'transparent') return true
      var match = value.match(/rgba?\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/)
      return Boolean(match && Number(match[1]) <= 0.01)
    }
    function getVisualLine(rect) {
      var found = visualLines.find(function(line) {
        return line.block === block && rect.bottom > line.top + 1 && rect.top < line.bottom - 1
      })
      if (!found) {
        found = { id: lineNo++, block: block, top: rect.top, bottom: rect.bottom }
        visualLines.push(found)
      } else {
        found.top = Math.min(found.top, rect.top)
        found.bottom = Math.max(found.bottom, rect.bottom)
      }
      return found.id
    }
    while ((n = walker.nextNode())) {
      diagnostics.textNodes++
      if (items.length >= MAX) { truncated = true; break }
      var raw = n.nodeValue || ''
      if (!raw || !raw.trim()) continue
      diagnostics.nonEmptyTextNodes++
      var el = n.parentElement
      if (!el) continue
      var cs = getComputedStyle(el)
      var ancestorInfo = inspectAncestors(el)
      if (ancestorInfo.hidden) {
        diagnostics[ancestorInfo.clipped ? 'hiddenByClip' : 'hiddenByStyle']++
        continue
      }
      if (colorIsTransparent(cs.color) || colorIsTransparent(cs.webkitTextFillColor)) {
        diagnostics.transparentText++
        continue
      }
      var block = getBlock(el)
      var pendingBreak = items.length > 0 && (block !== previousBlock || followsBreak(n))
      var segments = segmenter
        ? Array.from(segmenter.segment(raw)).map(function(s) { return { text: s.segment, start: s.index, end: s.index + s.segment.length } })
        : (function() {
            var offset = 0
            return Array.from(raw).map(function(c) {
              var result = { text: c, start: offset, end: offset + c.length }
              offset += c.length
              return result
            })
          })()
      var nodeLines = []
      segments.forEach(function(seg) {
        if (items.length >= MAX || graphemeCount >= MAX_GRAPHEMES) { truncated = true; return }
        var range = document.createRange()
        range.setStart(n, seg.start)
        range.setEnd(n, seg.end)
        var rects = Array.from(range.getClientRects()).filter(function(r) { return r.width > 0 || r.height > 0 })
        if (!rects.length) {
          diagnostics.noClientRects++
          if (/\r|\n/.test(seg.text)) pendingBreak = true
          return
        }
        var r = rects.find(function(rect) { return rectIsVisible(rect, ancestorInfo) })
        if (!r) { diagnostics.outsideVisibleClip++; return }
        var line = nodeLines.find(function(l) { return Math.abs(l.y - r.top) <= 1 && Math.abs(l.h - r.height) <= 2 })
        if (!line) {
          line = { line: getVisualLine(r), x: r.left - visualOffsetX, y: r.top - visualOffsetY, right: r.right - visualOffsetX, h: r.height, text: '', graphemes: [], breakBefore: pendingBreak }
          nodeLines.push(line)
          items.push(line)
        }
        if (pendingBreak && line.text.length === 0) line.breakBefore = true
        pendingBreak = false
        line.x = Math.min(line.x, r.left - visualOffsetX)
        line.right = Math.max(line.right, r.right - visualOffsetX)
        line.h = Math.max(line.h, r.height)
        line.text += seg.text
        line.graphemes.push({ text: seg.text, start: seg.start, end: seg.end, x: r.left - visualOffsetX, y: r.top - visualOffsetY, w: r.width, h: r.height, line: line.line })
        graphemeCount++
        diagnostics.acceptedGraphemes++
      })
      nodeLines.forEach(function(line) {
        line.w = line.right - line.x
        line.transformed = ancestorInfo.transformed
        line.verticalWriting = cs.writingMode !== 'horizontal-tb'
        line.viewportFixed = ancestorInfo.viewportFixed
        line.sticky = ancestorInfo.sticky
        line.direction = cs.direction || 'ltr'
      })
      if (nodeLines.length) previousBlock = block
    }
    return JSON.stringify({
      items: items,
      scrollOffsetX: scrollX,
      scrollOffsetY: scrollY,
      contentWidth: document.documentElement.scrollWidth || document.body.scrollWidth || 0,
      contentHeight: document.documentElement.scrollHeight || document.body.scrollHeight || 0,
      viewportWidth: vv ? vv.width : window.innerWidth,
      viewportHeight: vv ? vv.height : window.innerHeight,
      visualScale: vv ? vv.scale || 1 : 1,
      devicePixelRatio: window.devicePixelRatio || 1,
      documentRevision: documentRevision,
      nestedScrollRegions: nestedScrollRegions,
      diagnostics: diagnostics,
      truncated: truncated
    })
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) })
  }
})()`

/**
 * 提取页面文本层（冻结前调用）。
 * 主路径：executeJavaScript 按 grapheme 提取 Range 边界与视觉行顺序。
 * 降级路径：DOMSnapshot textBoxes（渲染层同样只绘制背景高亮）。
 */
export async function extractTextLayer(wc: WebContents): Promise<TextLayer | null> {
  let fallbackMetadata: {
    scrollOffsetX?: number
    scrollOffsetY?: number
    contentWidth?: number
    contentHeight?: number
    viewportWidth?: number
    viewportHeight?: number
    visualScale?: number
    devicePixelRatio?: number
    nestedScrollRegions?: Array<{ x?: number; y?: number; w?: number; h?: number; viewportFixed?: boolean }>
  } | null = null
  // 先 attach 但不 pause，保证主路径失败时 DOMSnapshot fallback 可用
  await attach(wc)
  // ——— 主路径：字符边界 + 视觉行提取———
  try {
    const ret = await wc.executeJavaScript(GLYPH_EXTRACT_SCRIPT)
    const parsed = JSON.parse(String(ret)) as {
      items?: Array<{
        text?: string
        x?: number
        y?: number
        w?: number
        h?: number
        line?: number
        breakBefore?: boolean
        transformed?: boolean
        verticalWriting?: boolean
        viewportFixed?: boolean
        sticky?: boolean
        direction?: string
        graphemes?: Array<{
          text?: string
          start?: number
          end?: number
          x?: number
          y?: number
          w?: number
          h?: number
          line?: number
        }>
      }>
      scrollOffsetX?: number
      scrollOffsetY?: number
      contentWidth?: number
      contentHeight?: number
      viewportWidth?: number
      viewportHeight?: number
      visualScale?: number
      devicePixelRatio?: number
      documentRevision?: number
      nestedScrollRegions?: Array<{ x?: number; y?: number; w?: number; h?: number; viewportFixed?: boolean }>
      diagnostics?: Record<string, number>
      truncated?: boolean
      error?: string
    }
    fallbackMetadata = parsed
    if (parsed.error) {
      console.warn('[freeze] ⚠️ 降级实现: 行盒提取失败，降级到 DOMSnapshot:', parsed.error)
    } else {
      const items: TextLayerItem[] = (parsed.items || [])
        .map((i) => ({
          text: i.text || '',
          x: Number(i.x) || 0,
          y: Number(i.y) || 0,
          w: Number(i.w) || 0,
          h: Number(i.h) || 0,
          line: Number(i.line) || 0,
          breakBefore: Boolean(i.breakBefore),
          transformed: Boolean(i.transformed),
          verticalWriting: Boolean(i.verticalWriting),
          viewportFixed: Boolean(i.viewportFixed),
          sticky: Boolean(i.sticky),
          direction: i.direction,
          graphemes: (i.graphemes || []).map((g) => ({
            text: g.text || '',
            start: Number(g.start) || 0,
            end: Number(g.end) || 0,
            x: Number(g.x) || 0,
            y: Number(g.y) || 0,
            w: Number(g.w) || 0,
            h: Number(g.h) || 0,
            line: Number(g.line) || 0,
          })),
        }))
        .filter((i) => i.text.length > 0)
      if (items.length > 0) {
        console.log(`[freeze] 文本层提取完成（字符边界+视觉行）: items=${items.length}, truncated=${Boolean(parsed.truncated)}`)
        return {
          version: 2,
          coordinateSpace: 'guest-visual-viewport-css-px-v2',
          items,
          scrollOffsetX: Number(parsed.scrollOffsetX) || 0,
          scrollOffsetY: Number(parsed.scrollOffsetY) || 0,
          contentWidth: Number(parsed.contentWidth) || 0,
          contentHeight: Number(parsed.contentHeight) || 0,
          viewportWidth: Number(parsed.viewportWidth) || 0,
          viewportHeight: Number(parsed.viewportHeight) || 0,
          visualScale: Number(parsed.visualScale) || 1,
          devicePixelRatio: Number(parsed.devicePixelRatio) || 1,
          documentRevision: Number(parsed.documentRevision) || 0,
          nestedScrollRegions: (parsed.nestedScrollRegions || []).map((region) => ({
            x: Number(region.x) || 0,
            y: Number(region.y) || 0,
            w: Number(region.w) || 0,
            h: Number(region.h) || 0,
            viewportFixed: Boolean(region.viewportFixed),
          })).filter((region) => region.w > 0 && region.h > 0),
          quality: 'glyph',
          truncated: Boolean(parsed.truncated),
        }
      }
      console.warn('[freeze] ⚠️ 降级实现: 字符文本层提取为空，降级到 DOMSnapshot:', parsed.diagnostics || {})
    }
  } catch (err) {
    console.warn('[freeze] ⚠️ 降级实现: 行盒提取异常，降级到 DOMSnapshot:', err)
  }

  // ——— 降级路径：DOMSnapshot textBoxes（仅文本盒，坐标精确）———
  try {
    const snap = await wc.debugger.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: false,
    })
    const strings: string[] = snap.strings || []
    const items: TextLayerItem[] = []
    const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics').catch(() => null)
    const visualViewport = metrics?.cssVisualViewport || metrics?.visualViewport
    const contentSize = metrics?.cssContentSize || metrics?.contentSize
    const rootDocument = snap.documents?.[0]
    const firstFinite = (...values: unknown[]): number => {
      for (const value of values) {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return numeric
      }
      return 0
    }
    const scrollOffsetX = firstFinite(fallbackMetadata?.scrollOffsetX, rootDocument?.scrollOffsetX, visualViewport?.pageX)
    const scrollOffsetY = firstFinite(fallbackMetadata?.scrollOffsetY, rootDocument?.scrollOffsetY, visualViewport?.pageY)
    const contentWidth = firstFinite(fallbackMetadata?.contentWidth, rootDocument?.contentWidth, contentSize?.width)
    const contentHeight = firstFinite(fallbackMetadata?.contentHeight, rootDocument?.contentHeight, contentSize?.height)
    const fallbackLines: Array<{ id: number; top: number; bottom: number }> = []
    const getFallbackLine = (top: number, height: number): number => {
      const bottom = top + height
      const found = fallbackLines.find((line) => (
        bottom > line.top + 1 && top < line.bottom - 1
      ))
      if (!found) {
        const line = { id: fallbackLines.length, top, bottom }
        fallbackLines.push(line)
        return line.id
      }
      found.top = Math.min(found.top, top)
      found.bottom = Math.max(found.bottom, bottom)
      return found.id
    }
    // Child-document rectangles require frame-owner transforms. Restrict the
    // fallback to the root document rather than emitting knowingly wrong boxes.
    for (const doc of rootDocument ? [rootDocument] : []) {
      const layouts = doc.layout
      const textBoxes = doc.textBoxes
      if (!layouts || !textBoxes) continue
      const textIndexes: number[] = layouts.text || []
      const boxLayoutIdx: number[] = textBoxes.layoutIndex || []
      const boxStart: number[] = textBoxes.start || []
      const boxLen: number[] = textBoxes.length || []
      const boxBounds: number[][] = textBoxes.bounds || []
      for (let i = 0; i < boxLayoutIdx.length && items.length < TEXT_LAYER_MAX_ITEMS; i++) {
        const li = boxLayoutIdx[i]
        if (li === undefined || li < 0 || li >= textIndexes.length) continue
        const sIdx = textIndexes[li]
        if (sIdx === undefined || sIdx === -1) continue
        const full = strings[sIdx] || ''
        const start = boxStart[i] || 0
        const len = boxLen[i] || 0
        const text = full.slice(start, start + len)
        if (!text || !text.trim()) continue
        const b = boxBounds[i]
        if (!b || b.length < 4) continue
        let minX: number, minY: number, w: number, h: number
        if (b.length >= 8) {
          // quad 格式: [x1,y1, x2,y2, x3,y3, x4,y4]
          // 对于轴对齐矩形: (b[0],b[1])=左上, (b[4],b[5])=右下
          const bx = [b[0], b[2], b[4], b[6]]
          const by = [b[1], b[3], b[5], b[7]]
          minX = Math.min(...bx)
          minY = Math.min(...by)
          w = Math.max(...bx) - minX
          h = Math.max(...by) - minY
        } else {
          // 简化格式: [x, y, w, h]
          minX = b[0]
          minY = b[1]
          w = b[2]
          h = b[3]
        }
        if (w <= 0 || h <= 0) continue
        const line = getFallbackLine(minY, h)
        items.push({
          text,
          x: minX - scrollOffsetX,
          y: minY - scrollOffsetY,
          w,
          h,
          line,
          breakBefore: items.length > 0 && items[items.length - 1].line !== line,
        })
      }
    }
    if (items.length > 0) {
      console.log(`[freeze] 文本层提取完成（DOMSnapshot textBoxes 降级）: items=${items.length}`)
      return {
        version: 2,
        coordinateSpace: 'guest-visual-viewport-css-px-v2',
        items,
        scrollOffsetX,
        scrollOffsetY,
        contentWidth,
        contentHeight,
        viewportWidth: firstFinite(fallbackMetadata?.viewportWidth, visualViewport?.clientWidth),
        viewportHeight: firstFinite(fallbackMetadata?.viewportHeight, visualViewport?.clientHeight),
        visualScale: firstFinite(fallbackMetadata?.visualScale, visualViewport?.scale, 1) || 1,
        devicePixelRatio: firstFinite(fallbackMetadata?.devicePixelRatio, 1) || 1,
        nestedScrollRegions: (fallbackMetadata?.nestedScrollRegions || []).map((region) => ({
          x: Number(region.x) || 0,
          y: Number(region.y) || 0,
          w: Number(region.w) || 0,
          h: Number(region.h) || 0,
          viewportFixed: Boolean(region.viewportFixed),
        })).filter((region) => region.w > 0 && region.h > 0),
        quality: 'domsnapshot',
        truncated: items.length >= TEXT_LAYER_MAX_ITEMS,
      }
    }
    console.warn('[freeze] DOMSnapshot 文本层为空（页面无可选文本？）')
    return null
  } catch (err) {
    console.warn('[freeze] 提取文本层失败:', err)
    return null
  }
}

/** 提取结束后页面若仍在流式更新/滚动，则旧字符坐标不能用于冻结帧。 */
export async function isTextLayerCurrent(wc: WebContents, layer: TextLayer): Promise<boolean> {
  if (layer.quality !== 'glyph' || layer.documentRevision === undefined) return true
  try {
    const current = await wc.executeJavaScript(`(() => {
      const state = window.__sidekickFreezeGeometryState
      const vv = window.visualViewport
      return {
        revision: state ? state.revision : -1,
        scrollX: vv ? vv.pageLeft || 0 : window.scrollX || 0,
        scrollY: vv ? vv.pageTop || 0 : window.scrollY || 0,
        width: vv ? vv.width : window.innerWidth,
        height: vv ? vv.height : window.innerHeight
      }
    })()`)
    return Number(current?.revision) === layer.documentRevision
      && Math.abs((Number(current?.scrollX) || 0) - layer.scrollOffsetX) <= 0.5
      && Math.abs((Number(current?.scrollY) || 0) - layer.scrollOffsetY) <= 0.5
      && Math.abs((Number(current?.width) || 0) - layer.viewportWidth) <= 0.5
      && Math.abs((Number(current?.height) || 0) - layer.viewportHeight) <= 0.5
  } catch {
    return false
  }
}
