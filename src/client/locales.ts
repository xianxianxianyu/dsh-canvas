import { MODES, MODE_IDS } from '../shared/modes.ts'

export const NS = 'canvas'

const titles = (language: 'zh' | 'en') => Object.fromEntries(MODE_IDS.map(id => [`mode.${id}`, MODES[id].title[language]]))

export const zh: Record<string, string> = {
  ...titles('zh'),
  invalid: '这个文件画不出来：',
  frame: '图预览',
  zoomIn: '放大',
  zoomOut: '缩小',
  fit: '适应窗口',
  actual: '原始大小',
}

export const en: typeof zh = {
  ...titles('en'),
  invalid: 'This file cannot be drawn:',
  frame: 'Diagram preview',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit to pane',
  actual: 'Actual size',
}
