import { useEffect, useRef } from 'react'

export default function UploadPanel({ onImage }) {
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
  }

  return (
    <div className="upload-inline" style={{ display:'flex', alignItems:'center', gap:'.5rem', width:'100%' }}>
      <div ref={dropRef} className="dropzone" style={{ flex:1 }}>
        拖拽图片到此处，或粘贴截图，或选择文件
      </div>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <button onClick={() => inputRef.current?.click()}>选择文件</button>
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onSelect} />
      </div>
    </div>
  )
}