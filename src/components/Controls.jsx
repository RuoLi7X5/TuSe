import { useMemo, useState } from 'react'
import PerformanceTuner from './PerformanceTuner.jsx'

export default function Controls({ palette, selectedColor, onSelectColor, onStartAddColorPick, pickMode, onAddColorFromPicker, onCancelPick }) {
  const initialSide = useMemo(() => {
    if (typeof window !== 'undefined') {
      const v = getComputedStyle(document.documentElement)?.getPropertyValue('--side-width')
      const n = parseInt(v?.trim()?.replace('px','') || '240', 10)
      if (Number.isFinite(n)) return Math.max(120, Math.min(360, n))
    }
    return 240
  }, [])
  const [sideWidth, setSideWidth] = useState(initialSide)
  const [showTuner, setShowTuner] = useState(false)
  const onChangeSide = (e) => {
    const n = parseInt(e.target.value, 10)
    setSideWidth(n)
    if (typeof window !== 'undefined') {
      document.documentElement?.style.setProperty('--side-width', `${n}px`)
    }
  }
  return (
    <div>
      <div style={{ marginBottom: '.5rem', color: '#a9b3c9', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span>颜色（来自图片识别）</span>
        <div style={{ display:'flex', gap:'.5rem' }}>
          <button onClick={onStartAddColorPick} style={{ padding: '.25rem .5rem', borderRadius: '6px', border: '1px solid var(--border)', background: pickMode? '#26417a':'#1a1f2b', color: 'var(--text)' }}>
            {pickMode? '取色中…（点击色带）' : '添加颜色（取色）'}
          </button>
          <button onClick={()=>setShowTuner(true)} style={{ padding: '.25rem .5rem', borderRadius: '6px', border: '1px solid var(--border)', background: '#1a1f2b', color: 'var(--text)' }} title="调整自动求解的性能参数">
            性能调节
          </button>
        </div>
      </div>
      {pickMode && (
        <div style={{ marginBottom: '.5rem' }}>
          <div
            onClick={(e)=> {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              const ratio = Math.max(0, Math.min(1, x / rect.width))
              const hue = Math.round(ratio * 360) % 360
              const hex = hslToHex(hue, 95, 55)
              onAddColorFromPicker?.(hex)
            }}
            style={{
              height: '24px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              cursor: 'crosshair',
              background: 'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #00ffff, #0000ff, #8b00ff)'
            }}
            title="点击色带以添加颜色到调色板"
          />
          <div style={{ display:'flex', justifyContent:'space-between', marginTop: '6px', fontSize: '12px', color: '#a9b3c9' }}>
            <span>提示：点击上方彩虹色带选择颜色</span>
            <button onClick={onCancelPick} style={{ padding: '2px 6px', borderRadius: '6px', border: '1px solid var(--border)', background: '#1a1f2b', color: 'var(--text)' }}>取消</button>
          </div>
        </div>
      )}
      <div className="grid-controls">
        <div className="row">
          <label htmlFor="layout-side-width">布局比例（两侧列宽，值越小画布越大）</label>
          <input id="layout-side-width" type="range" min="120" max="360" value={sideWidth} onChange={onChangeSide} />
          <span style={{ color:'#a9b3c9' }}>{sideWidth}px</span>
        </div>
      </div>
      <div className="palette">
        {palette.map((hex, i) => (
          <div
            key={i}
            className={`swatch ${selectedColor===hex?'selected':''}`}
            style={{ background: hex }}
            onClick={() => onSelectColor(hex)}
            title={hex}
          />
        ))}
      </div>
      {showTuner && <PerformanceTuner onClose={()=>setShowTuner(false)} />}
    </div>
  )
}
function hslToHex(h, s, l){
  s /= 100; l /= 100
  const c = (1 - Math.abs(2*l - 1)) * s
  const hh = h / 60
  const x = c * (1 - Math.abs(hh % 2 - 1))
  let r=0,g=0,b=0
  if (hh >= 0 && hh < 1) { r=c; g=x; b=0 }
  else if (hh < 2) { r=x; g=c; b=0 }
  else if (hh < 3) { r=0; g=c; b=x }
  else if (hh < 4) { r=0; g=x; b=c }
  else if (hh < 5) { r=x; g=0; b=c }
  else { r=c; g=0; b=x }
  const m = l - c/2
  const to255 = v => Math.max(0, Math.min(255, Math.round((v + m) * 255)))
  const toHex = n => n.toString(16).padStart(2, '0')
  return '#' + toHex(to255(r)) + toHex(to255(g)) + toHex(to255(b))
}