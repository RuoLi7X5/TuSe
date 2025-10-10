import { useState } from 'react'
import PerformanceTuner from './PerformanceTuner.jsx'

export default function Controls({ palette, selectedColor, onSelectColor, onStartAddColorPick, pickMode, onAddColorFromPicker, onCancelPick }) {
  const [showTuner, setShowTuner] = useState(false)
  return (
    <div>
      <div style={{ marginBottom: '.5rem', color: '#a9b3c9', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span>颜色</span>
        <div style={{ display:'flex', gap:'.5rem' }}>
          <button onClick={onStartAddColorPick} style={{ padding: '.25rem .5rem', borderRadius: '6px', border: '1px solid var(--border)', background: pickMode? '#26417a':'#1a1f2b', color: 'var(--text)' }}>
            {pickMode? '添加颜色中…（点击色带）' : '添加颜色'}
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
              const hex = sampleRainbow(ratio)
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
// 依据显示的线性渐变色带（7个固定色停靠点）进行精确插值
function sampleRainbow(ratio){
  const stops = ['#ff0000','#ff7f00','#ffff00','#00ff00','#00ffff','#0000ff','#8b00ff']
  const pos = [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1]
  const r = Math.max(0, Math.min(1, ratio))
  let i = 0
  for (let k=0;k<pos.length-1;k++){ if (r>=pos[k] && r<=pos[k+1]) { i=k; break } }
  const t = (r - pos[i]) / (pos[i+1]-pos[i])
  return mixHex(stops[i], stops[i+1], t)
}
function hexToRgb(hex){
  const h = hex.replace('#','')
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16)
  return { r, g, b }
}
function rgbToHex({r,g,b}){
  const toHex = n => Math.max(0,Math.min(255,n)).toString(16).padStart(2,'0')
  return '#' + toHex(r) + toHex(g) + toHex(b)
}
function mixHex(a,b,t){
  const c1 = hexToRgb(a), c2 = hexToRgb(b)
  const m = (x,y)=> Math.round(x*(1-t) + y*t)
  return rgbToHex({ r:m(c1.r,c2.r), g:m(c1.g,c2.g), b:m(c1.b,c2.b) })
}