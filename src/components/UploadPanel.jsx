import { useEffect, useRef } from 'react'

export default function UploadPanel({ onImage, targetColorCount, setTargetColorCount }) {
  const inputRef = useRef(null)
  const dropRef = useRef(null)

  useEffect(() => {
    const el = dropRef.current
    if (!el) return

    const prevent = (e) => { e.preventDefault(); e.stopPropagation() }
    const onDrop = (e) => {
      prevent(e)
      const file = e.dataTransfer?.files?.[0]
      if (file) onImage(file)
    }

    const onPaste = (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) onImage(file)
          break
        }
      }
    }

    ['dragenter','dragover','dragleave','drop'].forEach(evt => el.addEventListener(evt, prevent))
    el.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      ['dragenter','dragover','dragleave','drop'].forEach(evt => el.removeEventListener(evt, prevent))
      el.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [onImage])

  const onSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) onImage(file)
    e.target.value = '' // Reset input to allow re-selecting the same file
  }

  return (
    <div className="upload-inline" style={{ display:'flex', alignItems:'center', gap:'.5rem', width:'100%' }}>
      <div ref={dropRef} className="dropzone" style={{ flex:1 }}>
        拖拽图片到此处，或粘贴截图，或选择文件
      </div>
      <div className="toolbar" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button onClick={() => inputRef.current?.click()}>选择文件</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#a9b3c9', background: '#1a1f2b', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)' }}>
          <label htmlFor="targetColorCount" style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}>强制颜色数:</label>
          <input
            id="targetColorCount"
            type="number"
            min="1"
            max="32"
            value={targetColorCount || ''}
            onChange={(e) => setTargetColorCount(e.target.value ? parseInt(e.target.value) : '')}
            placeholder="自动"
            style={{ width: '40px', background: 'transparent', border: 'none', color: 'inherit', outline: 'none', textAlign: 'center' }}
            title="如果不为空，则强制识别结果包含指定数量的颜色（自动合并相近色）"
          />
        </div>
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onSelect} />
      </div>
    </div>
  )
}