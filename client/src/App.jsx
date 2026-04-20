import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import QRCode from 'qrcode'
import './App.css'

const host = window.location.hostname || 'localhost'
const defaultApiBase = `http://${host}:3001`

const emptyPartForm = {
  name: '',
  brand: '',
  partNumber: '',
  internalCode: '',
  barcode: '',
  quantity: 1,
  reorderThreshold: 0,
  reorderQty: 0,
  unitCost: 0,
  retailPrice: 0,
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
  'unitCost',
  'retailPrice',
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
  const [users, setUsers] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  const [stockMovements, setStockMovements] = useState([])
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('inventory:currentUser')
    return saved ? JSON.parse(saved) : null
  })
  const [loginForm, setLoginForm] = useState({ name: 'Owner', pin: '' })
  const [userForm, setUserForm] = useState({ name: '', role: 'tech', pin: '' })
  const [search, setSearch] = useState('')
  const [barcodeLookup, setBarcodeLookup] = useState('')
  const [scannerMode, setScannerMode] = useState('lookup')
  const [status, setStatus] = useState('')
  const [partForm, setPartForm] = useState(emptyPartForm)
  const [editingId, setEditingId] = useState(null)
  const [stockQtyById, setStockQtyById] = useState({})
  const [stockNoteById, setStockNoteById] = useState({})
  const [stockWorkorderById, setStockWorkorderById] = useState({})
  const [stockCustomerById, setStockCustomerById] = useState({})
  const [stockEquipmentById, setStockEquipmentById] = useState({})
  const [countQtyById, setCountQtyById] = useState({})
  const [countReason, setCountReason] = useState('Inventory count')
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
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('inventory:apiBase') || defaultApiBase)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const scannerControlsRef = useRef(null)

  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationType, setNewLocationType] = useState('bin')
  const [newLocationParentId, setNewLocationParentId] = useState('')

  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryParentId, setNewCategoryParentId] = useState('')
  const API = `${apiBase.replace(/\/$/, '')}/api`
  const ASSET_BASE = apiBase.replace(/\/$/, '')
  const canWrite = currentUser && ['owner', 'tech'].includes(currentUser.role)
  const canManage = currentUser?.role === 'owner'

  function authHeaders(extra = {}) {
    return currentUser ? { ...extra, 'x-user-id': String(currentUser.id) } : extra
  }

  function apiFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: authHeaders(options.headers || {})
    })
  }

  const loadAll = useCallback(async () => {
    const [p, l, c, t, u, a, m] = await Promise.all([
      fetch(`${API}/parts`),
      fetch(`${API}/locations`),
      fetch(`${API}/categories`),
      fetch(`${API}/transactions`),
      fetch(`${API}/users`),
      fetch(`${API}/audit`),
      fetch(`${API}/stock-movements`)
    ])

    setParts(await p.json())
    setLocations(await l.json())
    setCategories(await c.json())
    setTransactions(await t.json())
    setUsers(await u.json())
    setAuditLogs(await a.json())
    setStockMovements(await m.json())
  }, [API])

  useEffect(() => {
    Promise.resolve().then(loadAll).catch(() => {
      setStatus('Could not reach the server. Make sure the backend is running.')
    })
    fetch(`${API}/health`)
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => {})

    return () => stopCamera()
  }, [API, apiBase, loadAll])

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
      unitCost: Number(form.unitCost) || 0,
      retailPrice: Number(form.retailPrice) || 0,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      locationId: form.locationId ? Number(form.locationId) : null
    }
  }

  async function login(event) {
    event.preventDefault()
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginForm)
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Could not sign in.')
      return
    }
    localStorage.setItem('inventory:currentUser', JSON.stringify(data.user))
    setCurrentUser(data.user)
    setLoginForm((current) => ({ ...current, pin: '' }))
    setStatus(`Signed in as ${data.user.name}.`)
    loadAll()
  }

  function logout() {
    localStorage.removeItem('inventory:currentUser')
    setCurrentUser(null)
    setStatus('Signed out.')
  }

  async function addUser() {
    if (!canManage) return
    const res = await apiFetch(`${API}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userForm)
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add user.')
      return
    }
    setUserForm({ name: '', role: 'tech', pin: '' })
    setStatus('User added.')
    loadAll()
  }

  async function savePart() {
    if (!canWrite) {
      setStatus('Sign in as Owner or Tech to change inventory.')
      return
    }
    if (!partForm.name.trim()) {
      setStatus('Part name is required.')
      return
    }

    const url = editingId ? `${API}/parts/${editingId}` : `${API}/parts`
    const method = editingId ? 'PUT' : 'POST'
    const res = await apiFetch(url, {
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

    const res = await apiFetch(`${API}/parts/${id}`, { method: 'DELETE' })
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

    await apiFetch(`${API}/locations`, {
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

    await apiFetch(`${API}/categories`, {
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

    const res = await apiFetch(`${API}/categories/${id}`, { method: 'DELETE' })
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

    const res = await apiFetch(`${API}/locations/${id}`, { method: 'DELETE' })
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

    const res = await apiFetch(`${API}/parts/${id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        qty,
        note: stockNoteById[id] || '',
        workorderRef: stockWorkorderById[id] || '',
        customerRef: stockCustomerById[id] || '',
        equipmentRef: stockEquipmentById[id] || ''
      })
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

  async function saveCount(part) {
    if (!canWrite) {
      setStatus('Sign in as Owner or Tech to save inventory counts.')
      return
    }

    const quantity = Number(countQtyById[part.id])
    if (!Number.isFinite(quantity) || quantity < 0) {
      setStatus('Counted quantity must be zero or greater.')
      return
    }

    const res = await apiFetch(`${API}/parts/${part.id}/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity, reason: countReason })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to save count.')
      return
    }

    setStatus(`Count saved for ${part.name}. Adjustment: ${data.qtyChange > 0 ? '+' : ''}${data.qtyChange}.`)
    setCountQtyById((current) => ({ ...current, [part.id]: '' }))
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
  const purchaseList = useMemo(() => lowStockParts.map((part) => {
    const suggestedQty = Number(part.reorderQty) || Math.max(1, Number(part.reorderThreshold || 0) - Number(part.quantity || 0) + 1)
    return {
      ...part,
      suggestedQty,
      estimatedCost: suggestedQty * (Number(part.unitCost) || 0)
    }
  }), [lowStockParts])
  const inventoryValue = useMemo(
    () => parts.reduce((total, part) => total + (Number(part.quantity) || 0) * (Number(part.unitCost) || 0), 0),
    [parts]
  )

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
    if (match && scannerMode === 'checkout') {
      changeStock(match.id, 'checkout')
      setStatus(`Scanner checkout queued for ${match.name}.`)
      return
    }
    if (match && scannerMode === 'return') {
      changeStock(match.id, 'return')
      setStatus(`Scanner return queued for ${match.name}.`)
      return
    }
    if (!match && scannerMode === 'add') {
      setPartForm((current) => ({ ...current, barcode: trimmed, internalCode: current.internalCode || trimmed }))
      setStatus('No match. Code copied into the add part form.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
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

    const res = await apiFetch(`${API}/parts/import`, {
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
    return apiFetch(`${API}/uploads/image`, {
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
    const res = await apiFetch(`${API}/categories/${id}`, {
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
    const res = await apiFetch(`${API}/locations/${id}`, {
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
    const res = await apiFetch(`${API}/transactions/${transaction.id}`, {
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
    const res = await apiFetch(`${API}/transactions/${transaction.id}`, { method: 'DELETE' })
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

  function saveApiBase() {
    const cleaned = apiBase.replace(/\/$/, '')
    localStorage.setItem('inventory:apiBase', cleaned)
    setApiBase(cleaned)
    setStatus(`Server URL saved: ${cleaned}`)
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
          <div>
            <strong>${inventoryValue.toFixed(0)}</strong>
            <span>Stock value</span>
          </div>
        </div>
      </header>

      {status && <div className="status-bar">{status}</div>}

      <section className="session-panel">
        {currentUser ? (
          <>
            <div>
              <h2>{currentUser.name}</h2>
              <p>{currentUser.role} access is active.</p>
            </div>
            <button onClick={logout}>Sign Out</button>
          </>
        ) : (
          <form className="login-form" onSubmit={login}>
            <div>
              <h2>Sign In</h2>
              <p>Default PINs: Owner 1234, Tech 2468, Viewer 0000.</p>
            </div>
            <label>
              User
              <select value={loginForm.name} onChange={(e) => setLoginForm((current) => ({ ...current, name: e.target.value }))}>
                {users.map((user) => (
                  <option key={user.id} value={user.name}>
                    {user.name} ({user.role})
                  </option>
                ))}
                {users.length === 0 && <option value="Owner">Owner</option>}
              </select>
            </label>
            <label>
              PIN
              <input
                type="password"
                inputMode="numeric"
                value={loginForm.pin}
                onChange={(e) => setLoginForm((current) => ({ ...current, pin: e.target.value }))}
              />
            </label>
            <button className="primary-action" type="submit">Sign In</button>
          </form>
        )}
      </section>

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
            Scan action
            <select value={scannerMode} onChange={(e) => setScannerMode(e.target.value)}>
              <option value="lookup">Find part</option>
              <option value="checkout">Checkout 1</option>
              <option value="return">Return 1</option>
              <option value="add">Add new code</option>
            </select>
          </label>
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
        <div className="server-setting">
          <label>
            Server URL for Android
            <input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="http://192.168.1.158:3001"
            />
          </label>
          <button onClick={saveApiBase}>Save Server URL</button>
        </div>
        <label>
          Inventory count reason
          <input value={countReason} onChange={(e) => setCountReason(e.target.value)} />
        </label>
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

      {purchaseList.length > 0 && (
        <section className="purchase-panel">
          <div className="panel-title-row">
            <div>
              <h2>Reorder List</h2>
              <p>Use this as a purchase order starter for suppliers.</p>
            </div>
            <strong>${purchaseList.reduce((total, part) => total + part.estimatedCost, 0).toFixed(2)}</strong>
          </div>
          <div className="compact-list">
            {purchaseList.map((part) => (
              <div key={part.id}>
                <span>
                  <strong>{part.name}</strong> - {part.supplier || 'No supplier'} {part.supplierSku && `(${part.supplierSku})`}
                </span>
                <span>
                  Order {part.suggestedQty} - est. ${part.estimatedCost.toFixed(2)}
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
              Unit cost
              <input
                type="number"
                min="0"
                step="0.01"
                value={partForm.unitCost}
                onChange={(e) => updatePartForm('unitCost', e.target.value)}
              />
            </label>
            <label>
              Retail price
              <input
                type="number"
                min="0"
                step="0.01"
                value={partForm.retailPrice}
                onChange={(e) => updatePartForm('retailPrice', e.target.value)}
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
          <button className="primary-action" onClick={savePart} disabled={!canWrite}>
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
          <button onClick={addCategory} disabled={!canWrite}>Add Category</button>
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
          <button onClick={addLocation} disabled={!canWrite}>Add Location</button>
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
        <button onClick={importCsv} disabled={!canManage}>Import CSV</button>
      </section>

      <section className="admin-grid">
        <div className="panel">
          <h2>Users</h2>
          <div className="compact-list">
            {users.map((user) => (
              <div key={user.id}>
                <span>
                  <strong>{user.name}</strong> - {user.role}
                </span>
                <span>{user.active ? 'Active' : 'Disabled'}</span>
              </div>
            ))}
          </div>
          <div className="mini-form">
            <input
              placeholder="New user name"
              value={userForm.name}
              onChange={(e) => setUserForm((current) => ({ ...current, name: e.target.value }))}
            />
            <select value={userForm.role} onChange={(e) => setUserForm((current) => ({ ...current, role: e.target.value }))}>
              <option value="owner">Owner</option>
              <option value="tech">Tech</option>
              <option value="viewer">Viewer</option>
            </select>
            <input
              placeholder="PIN"
              type="password"
              inputMode="numeric"
              value={userForm.pin}
              onChange={(e) => setUserForm((current) => ({ ...current, pin: e.target.value }))}
            />
            <button onClick={addUser} disabled={!canManage}>Add User</button>
          </div>
        </div>
        <div className="panel">
          <h2>Stock Movement Ledger</h2>
          <div className="compact-list">
            {stockMovements.slice(0, 8).map((movement) => (
              <div key={movement.id}>
                <span>
                  <strong>{movement.partName || 'Unknown part'}</strong> - {movement.movementType}
                  {movement.workorderRef && ` - WO ${movement.workorderRef}`}
                </span>
                <span>
                  {movement.qtyChange > 0 ? `+${movement.qtyChange}` : movement.qtyChange} by {movement.userName || 'System'}
                </span>
              </div>
            ))}
            {stockMovements.length === 0 && <div className="empty-state">No stock movements yet.</div>}
          </div>
        </div>
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
                  <span>Cost: ${Number(p.unitCost || 0).toFixed(2)}</span>
                  <span>Retail: ${Number(p.retailPrice || 0).toFixed(2)}</span>
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
                  <input
                    className="stock-note"
                    placeholder="Workorder"
                    value={stockWorkorderById[p.id] || ''}
                    onChange={(e) => setStockWorkorderById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Workorder for ${p.name}`}
                  />
                  <input
                    className="stock-note"
                    placeholder="Customer"
                    value={stockCustomerById[p.id] || ''}
                    onChange={(e) => setStockCustomerById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Customer for ${p.name}`}
                  />
                  <input
                    className="stock-note"
                    placeholder="Vehicle/equipment"
                    value={stockEquipmentById[p.id] || ''}
                    onChange={(e) => setStockEquipmentById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Vehicle or equipment for ${p.name}`}
                  />
                  <button onClick={() => changeStock(p.id, 'checkout')} disabled={!canWrite}>Checkout</button>
                  <button onClick={() => changeStock(p.id, 'return')} disabled={!canWrite}>Return</button>
                </div>
                <div className="count-controls">
                  <input
                    type="number"
                    min="0"
                    placeholder={`Counted qty: ${p.quantity}`}
                    value={countQtyById[p.id] || ''}
                    onChange={(e) => setCountQtyById((current) => ({ ...current, [p.id]: e.target.value }))}
                    aria-label={`Counted quantity for ${p.name}`}
                  />
                  <button onClick={() => saveCount(p)} disabled={!canWrite}>Save Count</button>
                </div>
                <div className="button-row">
                  <button onClick={() => editPart(p)}>Edit</button>
                  <button className="danger-button" onClick={() => deletePart(p.id, p.name)} disabled={!canManage}>
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
                      <button onClick={() => saveCategoryEdit(c.id)} disabled={!canWrite}>Save</button>
                      <button onClick={() => setEditingCategoryId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startCategoryEdit(c)}>Edit</button>
                      <button onClick={() => deleteCategory(c.id, c.name)} disabled={!canManage}>Delete</button>
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
                      <button onClick={() => saveLocationEdit(l.id)} disabled={!canWrite}>Save</button>
                      <button onClick={() => setEditingLocationId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startLocationEdit(l)}>Edit</button>
                      <button onClick={() => deleteLocation(l.id, l.name)} disabled={!canManage}>Delete</button>
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
              {(t.workorderRef || t.customerRef || t.equipmentRef) && (
                <small>
                  {[t.workorderRef && `WO ${t.workorderRef}`, t.customerRef, t.equipmentRef].filter(Boolean).join(' - ')}
                </small>
              )}
              <input
                value={transactionDrafts[t.id] ?? t.note ?? ''}
                onChange={(e) => setTransactionDrafts((current) => ({ ...current, [t.id]: e.target.value }))}
                placeholder="Note"
                aria-label={`Note for transaction ${t.id}`}
              />
              <button onClick={() => saveTransactionNote(t)}>Save Note</button>
              <button className="danger-button" onClick={() => deleteTransaction(t)} disabled={!canManage}>Delete</button>
              <time>{t.timestamp}</time>
            </div>
          ))
        )}
      </section>

      <section className="transactions">
        <h2>Audit Log</h2>
        {auditLogs.length === 0 ? (
          <div className="empty-state">No audit events yet.</div>
        ) : (
          auditLogs.slice(0, 10).map((entry) => (
            <div key={entry.id}>
              <span>
                <strong>{entry.userName || 'System'}</strong> {entry.action} {entry.entityType || 'record'}
              </span>
              <small>{entry.details || ''}</small>
              <time>{entry.timestamp}</time>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
