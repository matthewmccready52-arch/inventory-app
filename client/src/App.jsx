import { useEffect, useMemo, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import QRCode from 'qrcode'
import './App.css'

const host = window.location.hostname || 'localhost'
const API = `http://${host}:3001/api`
const ASSET_BASE = `http://${host}:3001`

const emptyPartForm = {
  name: '',
  brand: '',
  partNumber: '',
  internalCode: '',
  barcode: '',
  quantity: 1,
  reorderThreshold: 0,
  reorderQty: 0,
  supplier: '',
  supplierSku: '',
  fitment: '',
  notes: '',
  imageUrl: '',
  categoryId: '',
  locationId: '',
  type: 'used',
  condition: 'untested',
  unit: 'each'
}

const csvHeaders = [
  'name',
  'brand',
  'partNumber',
  'internalCode',
  'barcode',
  'categoryId',
  'locationId',
  'condition',
  'unit',
  'quantity',
  'reorderThreshold',
  'reorderQty',
  'supplier',
  'supplierSku',
  'fitment',
  'notes',
  'imageUrl'
]

export default function App() {
  const [parts, setParts] = useState([])
  const [locations, setLocations] = useState([])
  const [categories, setCategories] = useState([])
  const [transactions, setTransactions] = useState([])
  const [search, setSearch] = useState('')
  const [barcodeLookup, setBarcodeLookup] = useState('')
  const [status, setStatus] = useState('')
  const [partForm, setPartForm] = useState(emptyPartForm)
  const [editingId, setEditingId] = useState(null)
  const [stockQtyById, setStockQtyById] = useState({})
  const [stockNoteById, setStockNoteById] = useState({})
  const [csvText, setCsvText] = useState('')
  const [cameraOn, setCameraOn] = useState(false)
  const [editingCategoryId, setEditingCategoryId] = useState(null)
  const [categoryDraft, setCategoryDraft] = useState({ name: '', parentId: '' })
  const [editingLocationId, setEditingLocationId] = useState(null)
  const [locationDraft, setLocationDraft] = useState({ name: '', type: 'bin', parentId: '' })
  const [installPrompt, setInstallPrompt] = useState(null)
  const [qrByPartId, setQrByPartId] = useState({})
  const [lastBackupAt, setLastBackupAt] = useState(() => localStorage.getItem('inventory:lastBackupAt') || '')
  const [selectedLabelIds, setSelectedLabelIds] = useState([])
  const [health, setHealth] = useState(null)
  const [transactionDrafts, setTransactionDrafts] = useState({})
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const scannerControlsRef = useRef(null)

  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationType, setNewLocationType] = useState('bin')
  const [newLocationParentId, setNewLocationParentId] = useState('')

  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryParentId, setNewCategoryParentId] = useState('')

  async function loadAll() {
    const [p, l, c, t] = await Promise.all([
      fetch(`${API}/parts`),
      fetch(`${API}/locations`),
      fetch(`${API}/categories`),
      fetch(`${API}/transactions`)
    ])

    setParts(await p.json())
    setLocations(await l.json())
    setCategories(await c.json())
    setTransactions(await t.json())
  }

  useEffect(() => {
    loadAll().catch(() => {
      setStatus('Could not reach the server. Make sure the backend is running.')
    })
    fetch(`${API}/health`)
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => {})

    return () => stopCamera()
  }, [])

  useEffect(() => {
    function handleInstallPrompt(event) {
      event.preventDefault()
      setInstallPrompt(event)
    }

    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
  }, [])

  function updatePartForm(field, value) {
    setPartForm((current) => ({ ...current, [field]: value }))
  }

  function assetUrl(src) {
    if (!src) return ''
    return src.startsWith('/uploads/') ? `${ASSET_BASE}${src}` : src
  }

  function toPayload(form) {
    return {
      ...form,
      name: form.name.trim(),
      brand: form.brand.trim(),
      partNumber: form.partNumber.trim(),
      internalCode: form.internalCode.trim(),
      barcode: form.barcode.trim(),
      supplier: form.supplier.trim(),
      supplierSku: form.supplierSku.trim(),
      fitment: form.fitment.trim(),
      notes: form.notes.trim(),
      imageUrl: form.imageUrl.trim(),
      quantity: Number(form.quantity) || 0,
      reorderThreshold: Number(form.reorderThreshold) || 0,
      reorderQty: Number(form.reorderQty) || 0,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      locationId: form.locationId ? Number(form.locationId) : null
    }
  }

  async function savePart() {
    if (!partForm.name.trim()) {
      setStatus('Part name is required.')
      return
    }

    const url = editingId ? `${API}/parts/${editingId}` : `${API}/parts`
    const method = editingId ? 'PUT' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(partForm))
    })

    if (!res.ok) {
      const data = await res.json()
      setStatus(data.error || 'Failed to save part.')
      return
    }

    setPartForm(emptyPartForm)
    setEditingId(null)
    setStatus(editingId ? 'Part updated.' : 'Part added.')
    loadAll()
  }

  function editPart(part) {
    setEditingId(part.id)
    setPartForm({
      ...emptyPartForm,
      ...part,
      categoryId: part.categoryId || '',
      locationId: part.locationId || '',
      imageUrl: part.imageUrl || ''
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelEdit() {
    setEditingId(null)
    setPartForm(emptyPartForm)
  }

  async function deletePart(id, name) {
    const ok = window.confirm(`Delete part "${name}"? This removes it from inventory.`)
    if (!ok) return

    const res = await fetch(`${API}/parts/${id}`, { method: 'DELETE' })
    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Failed to delete part.')
      return
    }

    setStatus(data.deleted ? 'Part deleted.' : 'Part was already gone.')
    loadAll()
  }

  async function addLocation() {
    if (!newLocationName.trim()) return

    await fetch(`${API}/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newLocationName.trim(),
        type: newLocationType,
        parentId: newLocationParentId ? Number(newLocationParentId) : null
      })
    })

    setNewLocationName('')
    setNewLocationType('bin')
    setNewLocationParentId('')
    setStatus('Location added.')
    loadAll()
  }

  async function addCategory() {
    if (!newCategoryName.trim()) return

    await fetch(`${API}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newCategoryName.trim(),
        parentId: newCategoryParentId ? Number(newCategoryParentId) : null
      })
    })

    setNewCategoryName('')
    setNewCategoryParentId('')
    setStatus('Category added.')
    loadAll()
  }

  async function deleteCategory(id, name) {
    const ok = window.confirm(`Delete category "${name}"?`)
    if (!ok) return

    const res = await fetch(`${API}/categories/${id}`, { method: 'DELETE' })
    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Failed to delete category.')
      return
    }

    setStatus('Category deleted.')
    loadAll()
  }

  async function deleteLocation(id, name) {
    const ok = window.confirm(`Delete location "${name}"?`)
    if (!ok) return

    const res = await fetch(`${API}/locations/${id}`, { method: 'DELETE' })
    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Failed to delete location.')
      return
    }

    setStatus('Location deleted.')
    loadAll()
  }

  async function changeStock(id, action) {
    const qty = Number(stockQtyById[id] || 1)
    if (!Number.isFinite(qty) || qty <= 0) {
      setStatus('Quantity must be greater than zero.')
      return
    }

    const res = await fetch(`${API}/parts/${id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty, note: stockNoteById[id] || '' })
    })

    if (!res.ok) {
      const data = await res.json()
      setStatus(data.error || `Failed to ${action} part.`)
      return
    }

    setStatus(action === 'checkout' ? `Checked out ${qty}.` : `Returned ${qty}.`)
    setStockNoteById((current) => ({ ...current, [id]: '' }))
    loadAll()
  }

  function buildMap(list) {
    const obj = {}
    for (const item of list) obj[item.id] = item
    return obj
  }

  const locMap = useMemo(() => buildMap(locations), [locations])
  const catMap = useMemo(() => buildMap(categories), [categories])

  function getPath(id, mapObj) {
    if (!id) return 'None'

    const names = []
    let current = mapObj[id]

    while (current) {
      names.unshift(current.name)
      current = current.parentId ? mapObj[current.parentId] : null
    }

    return names.join(' > ')
  }

  function isLowStock(part) {
    return Number(part.reorderThreshold) > 0 && Number(part.quantity) <= Number(part.reorderThreshold)
  }

  const lowStockParts = useMemo(() => parts.filter(isLowStock), [parts])

  const duplicateCodes = useMemo(() => {
    const seen = {}
    for (const part of parts) {
      for (const field of ['barcode', 'internalCode', 'partNumber']) {
        const value = String(part[field] || '').trim().toLowerCase()
        if (!value) continue
        const key = `${field}:${value}`
        seen[key] = seen[key] || []
        seen[key].push(part)
      }
    }
    return Object.fromEntries(Object.entries(seen).filter(([, matches]) => matches.length > 1))
  }, [parts])

  const duplicateWarnings = useMemo(() => {
    const warnings = []
    for (const field of ['barcode', 'internalCode', 'partNumber']) {
      const value = String(partForm[field] || '').trim().toLowerCase()
      if (!value) continue
      const matches = parts.filter((part) => {
        if (editingId && part.id === editingId) return false
        return String(part[field] || '').trim().toLowerCase() === value
      })
      if (matches.length > 0) warnings.push(`${field} already used by ${matches.map((part) => part.name).join(', ')}`)
    }
    return warnings
  }, [partForm, parts, editingId])

  const filteredParts = useMemo(() => parts.filter((p) => {
    const q = search.trim().toLowerCase()
    if (!q) return true

    const haystack = [
      p.name,
      p.brand,
      p.partNumber,
      p.internalCode,
      p.barcode,
      p.supplier,
      p.supplierSku,
      p.fitment,
      getPath(p.categoryId, catMap),
      getPath(p.locationId, locMap)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(q)
  }), [parts, search, catMap, locMap])

  useEffect(() => {
    let alive = true

    async function generateQrCodes() {
      const entries = await Promise.all(
        filteredParts.map(async (part) => {
          const code = getLabelCode(part)
          const qr = await QRCode.toDataURL(code, {
            margin: 1,
            width: 160,
            color: {
              dark: '#111111',
              light: '#ffffff'
            }
          })
          return [part.id, qr]
        })
      )

      if (alive) setQrByPartId(Object.fromEntries(entries))
    }

    generateQrCodes().catch(() => {
      if (alive) setStatus('Could not generate QR labels.')
    })

    return () => {
      alive = false
    }
  }, [filteredParts])

  function applyLookup(code) {
    const trimmed = code.trim()
    if (!trimmed) return

    const match = parts.find((part) => {
      return [part.barcode, part.internalCode, part.partNumber]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === trimmed.toLowerCase())
    })

    setBarcodeLookup(trimmed)
    setSearch(trimmed)
    setStatus(match ? `Found ${match.name}.` : 'No exact barcode, code, or part number match.')
  }

  function scanLookup(event) {
    event.preventDefault()
    applyLookup(barcodeLookup)
  }

  async function startCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('Camera access is not available in this browser. A USB scanner still works.')
        return
      }

      setCameraOn(true)
      setStatus('Starting camera scanner...')

      const reader = new BrowserMultiFormatReader()
      scannerControlsRef.current = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current,
        (result) => {
          if (!result) return
          applyLookup(result.getText())
          stopCamera()
        }
      )
    } catch {
      setStatus('Could not start camera. Check browser camera permission.')
      setCameraOn(false)
    }
  }

  function stopCamera() {
    if (scannerControlsRef.current) {
      scannerControlsRef.current.stop()
      scannerControlsRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    setCameraOn(false)
  }

  function parseCsv(text) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length < 2) return []

    const splitLine = (line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''))
    const headers = splitLine(lines[0])

    return lines.slice(1).map((line) => {
      const values = splitLine(line)
      const row = {}
      headers.forEach((header, index) => {
        row[header] = values[index] || ''
      })
      return row
    })
  }

  async function importCsv() {
    const importedParts = parseCsv(csvText)

    if (importedParts.length === 0) {
      setStatus('Paste a CSV with a header row and at least one part.')
      return
    }

    const res = await fetch(`${API}/parts/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: importedParts })
    })

    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Import failed.')
      return
    }

    setCsvText('')
    setStatus(`Imported ${data.imported} parts.`)
    loadAll()
  }

  function loadCsvFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCsvText(String(reader.result || ''))
    reader.readAsText(file)
  }

  function uploadDataUrl(dataUrl, fileName) {
    return fetch(`${API}/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, fileName })
    }).then(async (res) => {
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to upload image')
      return data.imageUrl
    })
  }

  function loadPartImage(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const imageUrl = await uploadDataUrl(String(reader.result || ''), file.name)
        updatePartForm('imageUrl', imageUrl)
        setStatus('Photo uploaded.')
      } catch (err) {
        setStatus(err.message)
      }
    }
    reader.readAsDataURL(file)
  }

  function downloadPartsCsv() {
    window.location.href = `${API}/parts/export`
  }

  function downloadLowStockCsv() {
    window.location.href = `${API}/parts/export/low-stock`
  }

  function downloadBackup() {
    const now = new Date().toISOString()
    localStorage.setItem('inventory:lastBackupAt', now)
    setLastBackupAt(now)
    setStatus('Backup download started.')
    window.location.href = `${API}/backup`
  }

  function restoreBackup(file) {
    if (!file) return
    const ok = window.confirm('Restore this database backup? This replaces the current database after the server closes it.')
    if (!ok) return

    const reader = new FileReader()
    reader.onload = async () => {
      const res = await fetch(`${API}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: String(reader.result || '') })
      })
      const data = await res.json()
      setStatus(data.message || data.error || 'Restore finished.')
    }
    reader.readAsDataURL(file)
  }

  async function saveCategoryEdit(id) {
    const res = await fetch(`${API}/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: categoryDraft.name,
        parentId: categoryDraft.parentId ? Number(categoryDraft.parentId) : null
      })
    })
    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Failed to update category.')
      return
    }

    setEditingCategoryId(null)
    setStatus('Category updated.')
    loadAll()
  }

  function startCategoryEdit(category) {
    setEditingCategoryId(category.id)
    setCategoryDraft({ name: category.name, parentId: category.parentId || '' })
  }

  async function saveLocationEdit(id) {
    const res = await fetch(`${API}/locations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: locationDraft.name,
        type: locationDraft.type,
        parentId: locationDraft.parentId ? Number(locationDraft.parentId) : null
      })
    })
    const data = await res.json()

    if (!res.ok) {
      setStatus(data.error || 'Failed to update location.')
      return
    }

    setEditingLocationId(null)
    setStatus('Location updated.')
    loadAll()
  }

  function startLocationEdit(location) {
    setEditingLocationId(location.id)
    setLocationDraft({
      name: location.name,
      type: location.type || 'bin',
      parentId: location.parentId || ''
    })
  }

  function getLabelCode(part) {
    return part.barcode || part.internalCode || part.partNumber || `PART-${part.id}`
  }

  function printLabels() {
    window.print()
  }

  function toggleLabelSelection(id) {
    setSelectedLabelIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    )
  }

  const printableParts = selectedLabelIds.length > 0
    ? filteredParts.filter((part) => selectedLabelIds.includes(part.id))
    : filteredParts

  async function saveTransactionNote(transaction) {
    const note = transactionDrafts[transaction.id] ?? transaction.note ?? ''
    const res = await fetch(`${API}/transactions/${transaction.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to update transaction.')
      return
    }
    setStatus('Transaction note updated.')
    loadAll()
  }

  async function deleteTransaction(transaction) {
    const ok = window.confirm(`Delete this ${transaction.type} transaction? Stock quantity will not be changed.`)
    if (!ok) return
    const res = await fetch(`${API}/transactions/${transaction.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to delete transaction.')
      return
    }
    setStatus('Transaction deleted.')
    loadAll()
  }

  async function installApp() {
    if (!installPrompt) {
      setStatus('Use Chrome menu > Add to Home screen if the install prompt is not available yet.')
      return
    }

    installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  function backupAgeText() {
    if (!lastBackupAt) return 'No backup recorded on this device.'

    const ageMs = Date.now() - new Date(lastBackupAt).getTime()
    const days = Math.max(0, Math.floor(ageMs / 86400000))
    if (days === 0) return 'Backed up today.'
    if (days === 1) return 'Last backup was yesterday.'
    return `Last backup was ${days} days ago.`
  }

  function backupNeedsAttention() {
    if (!lastBackupAt) return true
    return Date.now() - new Date(lastBackupAt).getTime() > 7 * 86400000
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Inventory</p>
          <h1>Parts, places, and stock.</h1>
        </div>
        <div className="stats-grid" aria-label="Inventory totals">
          <div>
            <strong>{parts.length}</strong>
            <span>Parts</span>
          </div>
          <div>
            <strong>{locations.length}</strong>
            <span>Locations</span>
          </div>
          <div className={lowStockParts.length ? 'danger-stat' : ''}>
            <strong>{lowStockParts.length}</strong>
            <span>Low stock</span>
          </div>
        </div>
      </header>

      {status && <div className="status-bar">{status}</div>}

      <section className="toolbar" aria-label="Search and scan">
        <label>
          Search everything
          <input
            placeholder="Name, barcode, category, location, supplier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <form className="scan-form" onSubmit={scanLookup}>
          <label>
            Barcode scanner
            <input
              placeholder="Scan or type code, then Enter"
              value={barcodeLookup}
              onChange={(e) => setBarcodeLookup(e.target.value)}
            />
          </label>
          <button type="submit">Find</button>
          <button type="button" onClick={cameraOn ? stopCamera : startCamera}>
            {cameraOn ? 'Stop Camera' : 'Camera Scan'}
          </button>
        </form>
      </section>

      <video ref={videoRef} className={cameraOn ? 'scanner-video on' : 'scanner-video'} muted playsInline />

      <section className="ops-panel">
        <div>
          <h2>Tools</h2>
          <p>Export, back up, restore, print labels, and open the app from another device on this network.</p>
        </div>
        <div className={backupNeedsAttention() ? 'backup-reminder warn' : 'backup-reminder'}>
          {backupAgeText()}
        </div>
        <div className="ops-actions">
          <button onClick={downloadPartsCsv}>Export CSV</button>
          <button onClick={downloadLowStockCsv}>Export Low Stock</button>
          <button onClick={downloadBackup}>Download Backup</button>
          <label className="restore-picker">
            Restore DB
            <input type="file" accept=".db,.sqlite,application/octet-stream" onChange={(e) => restoreBackup(e.target.files[0])} />
          </label>
          <button onClick={printLabels}>Print Labels</button>
          <button onClick={installApp}>Install App</button>
        </div>
        <div className="phone-help">
          Frontend: http://{host}:5173
          <br />
          Backend: http://{host}:3001
          {health?.lanAddresses?.length > 0 && (
            <>
              <br />
              Phone: http://{health.lanAddresses[0]}:5173
            </>
          )}
        </div>
      </section>

      {lowStockParts.length > 0 && (
        <section className="low-stock">
          <h2>Low Stock</h2>
          <div className="alert-list">
            {lowStockParts.map((part) => (
              <div key={part.id}>
                <strong>{part.name}</strong>
                <span>
                  Qty {part.quantity} / reorder at {part.reorderThreshold}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="forms-grid" aria-label="Add inventory records">
        <div className="panel wide-panel">
          <div className="panel-title-row">
            <h2>{editingId ? 'Edit Part' : 'Add Part'}</h2>
            {editingId && <button onClick={cancelEdit}>Cancel edit</button>}
          </div>
          <div className="field-grid">
            <label>
              Name
              <input value={partForm.name} onChange={(e) => updatePartForm('name', e.target.value)} />
            </label>
            <label>
              Brand
              <input value={partForm.brand} onChange={(e) => updatePartForm('brand', e.target.value)} />
            </label>
            <label>
              Part number
              <input value={partForm.partNumber} onChange={(e) => updatePartForm('partNumber', e.target.value)} />
            </label>
            <label>
              Internal code
              <input value={partForm.internalCode} onChange={(e) => updatePartForm('internalCode', e.target.value)} />
            </label>
            <label>
              Barcode
              <input value={partForm.barcode} onChange={(e) => updatePartForm('barcode', e.target.value)} />
            </label>
            <label>
              Qty
              <input
                type="number"
                min="0"
                value={partForm.quantity}
                onChange={(e) => updatePartForm('quantity', e.target.value)}
              />
            </label>
            <label>
              Reorder at
              <input
                type="number"
                min="0"
                value={partForm.reorderThreshold}
                onChange={(e) => updatePartForm('reorderThreshold', e.target.value)}
              />
            </label>
            <label>
              Reorder qty
              <input
                type="number"
                min="0"
                value={partForm.reorderQty}
                onChange={(e) => updatePartForm('reorderQty', e.target.value)}
              />
            </label>
            <label>
              Category
              <select value={partForm.categoryId} onChange={(e) => updatePartForm('categoryId', e.target.value)}>
                <option value="">No Category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {getPath(c.id, catMap)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location
              <select value={partForm.locationId} onChange={(e) => updatePartForm('locationId', e.target.value)}>
                <option value="">No Location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {getPath(l.id, locMap)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Condition
              <select value={partForm.condition} onChange={(e) => updatePartForm('condition', e.target.value)}>
                <option value="untested">Untested</option>
                <option value="good">Good</option>
                <option value="core">Core</option>
                <option value="new">New</option>
                <option value="damaged">Damaged</option>
              </select>
            </label>
            <label>
              Supplier
              <input value={partForm.supplier} onChange={(e) => updatePartForm('supplier', e.target.value)} />
            </label>
            <label>
              Supplier SKU
              <input value={partForm.supplierSku} onChange={(e) => updatePartForm('supplierSku', e.target.value)} />
            </label>
            <label className="full-field">
              Photo URL
              <input value={partForm.imageUrl} onChange={(e) => updatePartForm('imageUrl', e.target.value)} />
            </label>
            <label>
              Photo file
              <input type="file" accept="image/*" onChange={(e) => loadPartImage(e.target.files[0])} />
            </label>
            <label className="full-field">
              Fitment
              <input value={partForm.fitment} onChange={(e) => updatePartForm('fitment', e.target.value)} />
            </label>
            <label className="full-field">
              Notes
              <textarea value={partForm.notes} onChange={(e) => updatePartForm('notes', e.target.value)} />
            </label>
          </div>
          {duplicateWarnings.length > 0 && (
            <div className="duplicate-warning">
              {duplicateWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
          {partForm.imageUrl && <img className="form-photo-preview" src={assetUrl(partForm.imageUrl)} alt="" />}
          <button className="primary-action" onClick={savePart}>
            {editingId ? 'Save Changes' : 'Add Part'}
          </button>
        </div>

        <div className="panel">
          <h2>Add Category</h2>
          <label>
            Category name
            <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
          </label>
          <label>
            Parent
            <select value={newCategoryParentId} onChange={(e) => setNewCategoryParentId(e.target.value)}>
              <option value="">No Parent</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {getPath(c.id, catMap)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={addCategory}>Add Category</button>
        </div>

        <div className="panel">
          <h2>Add Location</h2>
          <label>
            Location name
            <input value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
          </label>
          <label>
            Type
            <select value={newLocationType} onChange={(e) => setNewLocationType(e.target.value)}>
              <option value="room">Room</option>
              <option value="section">Section</option>
              <option value="shelf">Shelf</option>
              <option value="rack">Rack</option>
              <option value="bin">Bin</option>
              <option value="drawer">Drawer</option>
            </select>
          </label>
          <label>
            Parent
            <select value={newLocationParentId} onChange={(e) => setNewLocationParentId(e.target.value)}>
              <option value="">No Parent</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {getPath(l.id, locMap)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={addLocation}>Add Location</button>
        </div>
      </section>

      <section className="import-panel">
        <div>
          <h2>CSV Import</h2>
          <p>Headers: {csvHeaders.join(', ')}</p>
        </div>
        <input type="file" accept=".csv,text/csv" onChange={(e) => loadCsvFile(e.target.files[0])} />
        <textarea
          placeholder="Paste CSV rows here"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />
        <button onClick={importCsv}>Import CSV</button>
      </section>

      <section className="parts-section">
        <h2>Parts</h2>
        {filteredParts.length === 0 ? (
          <div className="empty-state">No matching parts.</div>
        ) : (
          <div className="parts-grid">
            {filteredParts.map((p) => (
              <article key={p.id} className={isLowStock(p) ? 'part-card low' : 'part-card'}>
                <label className="label-select">
                  <input
                    type="checkbox"
                    checked={selectedLabelIds.includes(p.id)}
                    onChange={() => toggleLabelSelection(p.id)}
                  />
                  Print label
                </label>
                {p.imageUrl && <img className="part-photo" src={assetUrl(p.imageUrl)} alt="" />}
                <div className="part-card-header">
                  <div>
                    <strong>{p.name}</strong>
                    <span>{[p.brand, p.partNumber].filter(Boolean).join(' - ') || 'No part number'}</span>
                  </div>
                  {isLowStock(p) && <em>Low</em>}
                </div>
                {Object.values(duplicateCodes).some((matches) => matches.some((match) => match.id === p.id)) && (
                  <div className="duplicate-chip">Duplicate code warning</div>
                )}
                <div className="part-meta">
                  <span>Qty: {p.quantity}</span>
                  <span>Reorder: {p.reorderThreshold || 0}</span>
                  <span>Barcode: {p.barcode || 'None'}</span>
                  <span>Code: {p.internalCode || 'None'}</span>
                  <span>Category: {getPath(p.categoryId, catMap)}</span>
                  <span>Location: {getPath(p.locationId, locMap)}</span>
                  <span>Condition: {p.condition || 'None'}</span>
                  <span>Supplier: {p.supplier || 'None'}</span>
                </div>
                {p.fitment && <p className="note-line">Fits: {p.fitment}</p>}
                {p.notes && <p className="note-line">{p.notes}</p>}
                <div className="stock-controls">
                  <input
                    type="number"
                    min="1"
                    value={stockQtyById[p.id] || 1}
                    onChange={(e) => setStockQtyById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Quantity for ${p.name}`}
                  />
                  <input
                    className="stock-note"
                    placeholder="Reason or job"
                    value={stockNoteById[p.id] || ''}
                    onChange={(e) => setStockNoteById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Reason for ${p.name}`}
                  />
                  <button onClick={() => changeStock(p.id, 'checkout')}>Checkout</button>
                  <button onClick={() => changeStock(p.id, 'return')}>Return</button>
                </div>
                <div className="button-row">
                  <button onClick={() => editPart(p)}>Edit</button>
                  <button className="danger-button" onClick={() => deletePart(p.id, p.name)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="labels-sheet" aria-label="Printable labels">
        <div className="labels-header">
          <div>
            <h2>Printable Labels</h2>
            <p>
              {printableParts.length === 0
                ? 'No labels ready. Add parts or clear your search.'
                : `${printableParts.length} label${printableParts.length === 1 ? '' : 's'} ready${selectedLabelIds.length > 0 ? ' from your selection' : ' for the current parts list'}.`}
            </p>
          </div>
          <div className="label-actions">
            {selectedLabelIds.length > 0 && <button onClick={() => setSelectedLabelIds([])}>Clear Selection</button>}
            <button onClick={printLabels} disabled={printableParts.length === 0}>
            Print Labels
            </button>
          </div>
        </div>
        {printableParts.length === 0 ? (
          <div className="empty-state">No matching parts to print.</div>
        ) : (
          <div className="labels-grid">
            {printableParts.map((part) => {
              const code = getLabelCode(part)
              return (
                <article className="print-label" key={part.id}>
                  {qrByPartId[part.id] ? (
                    <img className="label-code" src={qrByPartId[part.id]} alt="" />
                  ) : (
                    <div className="label-code pending" aria-hidden="true" />
                  )}
                  <div>
                    <strong>{part.name}</strong>
                    <span>{code}</span>
                    <small>{getPath(part.locationId, locMap)}</small>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="manage-grid">
        <div>
          <h2>Categories</h2>
          <div className="compact-list">
            {categories.length === 0 ? (
              <div className="empty-state">No categories yet.</div>
            ) : (
              categories.map((c) => (
                <div key={c.id}>
                  {editingCategoryId === c.id ? (
                    <span className="inline-edit">
                      <input value={categoryDraft.name} onChange={(e) => setCategoryDraft((current) => ({ ...current, name: e.target.value }))} />
                      <select value={categoryDraft.parentId} onChange={(e) => setCategoryDraft((current) => ({ ...current, parentId: e.target.value }))}>
                        <option value="">No Parent</option>
                        {categories
                          .filter((option) => option.id !== c.id)
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {getPath(option.id, catMap)}
                            </option>
                          ))}
                      </select>
                    </span>
                  ) : (
                    <span>
                      <strong>{c.name}</strong> - Parent: {c.parentId ? getPath(c.parentId, catMap) : 'None'}
                    </span>
                  )}
                  {editingCategoryId === c.id ? (
                    <>
                      <button onClick={() => saveCategoryEdit(c.id)}>Save</button>
                      <button onClick={() => setEditingCategoryId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startCategoryEdit(c)}>Edit</button>
                      <button onClick={() => deleteCategory(c.id, c.name)}>Delete</button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <h2>Locations</h2>
          <div className="compact-list">
            {locations.length === 0 ? (
              <div className="empty-state">No locations yet.</div>
            ) : (
              locations.map((l) => (
                <div key={l.id}>
                  {editingLocationId === l.id ? (
                    <span className="inline-edit">
                      <input value={locationDraft.name} onChange={(e) => setLocationDraft((current) => ({ ...current, name: e.target.value }))} />
                      <select value={locationDraft.type} onChange={(e) => setLocationDraft((current) => ({ ...current, type: e.target.value }))}>
                        <option value="room">Room</option>
                        <option value="section">Section</option>
                        <option value="shelf">Shelf</option>
                        <option value="rack">Rack</option>
                        <option value="bin">Bin</option>
                        <option value="drawer">Drawer</option>
                      </select>
                      <select value={locationDraft.parentId} onChange={(e) => setLocationDraft((current) => ({ ...current, parentId: e.target.value }))}>
                        <option value="">No Parent</option>
                        {locations
                          .filter((option) => option.id !== l.id)
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {getPath(option.id, locMap)}
                            </option>
                          ))}
                      </select>
                    </span>
                  ) : (
                    <span>
                      <strong>{l.name}</strong> - {l.type} - Parent: {l.parentId ? getPath(l.parentId, locMap) : 'None'}
                    </span>
                  )}
                  {editingLocationId === l.id ? (
                    <>
                      <button onClick={() => saveLocationEdit(l.id)}>Save</button>
                      <button onClick={() => setEditingLocationId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startLocationEdit(l)}>Edit</button>
                      <button onClick={() => deleteLocation(l.id, l.name)}>Delete</button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="transactions">
        <h2>Recent Activity</h2>
        {transactions.length === 0 ? (
          <div className="empty-state">No checkouts or returns yet.</div>
        ) : (
          transactions.slice(0, 8).map((t) => (
            <div key={t.id}>
              <span>{t.partName || 'Unknown part'}</span>
              <strong>{t.qtyChange > 0 ? `+${t.qtyChange}` : t.qtyChange}</strong>
              <input
                value={transactionDrafts[t.id] ?? t.note ?? ''}
                onChange={(e) => setTransactionDrafts((current) => ({ ...current, [t.id]: e.target.value }))}
                placeholder="Note"
                aria-label={`Note for transaction ${t.id}`}
              />
              <button onClick={() => saveTransactionNote(t)}>Save Note</button>
              <button className="danger-button" onClick={() => deleteTransaction(t)}>Delete</button>
              <time>{t.timestamp}</time>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
