import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import QRCode from 'qrcode'
import './App.css'

const host = window.location.hostname || 'localhost'
const defaultApiBase = `http://${host}:3001`
const LOCAL_DB_KEY = 'inventory:offline-db'
const LOCAL_MODE_KEY = 'inventory:storageMode'
const PASSCODE_KEY = 'inventory:appPasscode'

const localUsers = [
  { id: 1, name: 'Owner', role: 'owner', pin: '1234', active: 1 },
  { id: 2, name: 'Tech', role: 'tech', pin: '2468', active: 1 },
  { id: 3, name: 'Viewer', role: 'viewer', pin: '0000', active: 1 }
]

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

const emptyCustomerForm = { name: '', phone: '', email: '', notes: '' }
const emptyEquipmentForm = {
  customerId: '',
  name: '',
  year: '',
  make: '',
  model: '',
  vin: '',
  serial: '',
  serialPhotoUrl: '',
  fleetPhotoUrl: '',
  unitNumber: '',
  mileage: '',
  hours: '',
  notes: ''
}
const emptyWorkorderForm = {
  number: '',
  title: '',
  status: 'open',
  customerId: '',
  equipmentId: '',
  complaint: '',
  diagnosis: '',
  laborNotes: '',
  laborHours: 0,
  laborRate: 0
}
const emptyWorkorderPartForm = { workorderId: '', partId: '', qty: 1, mode: 'reserve', note: '' }
const emptyPasscodeForm = { passcode: '', confirmPasscode: '' }

function nowIso() {
  return new Date().toISOString()
}

function createDefaultLocalDb() {
  return {
    meta: {
      nextPartId: 1,
      nextLocationId: 1,
      nextCategoryId: 1,
      nextTransactionId: 1,
      nextUserId: 4,
      nextCustomerId: 1,
      nextEquipmentId: 1,
      nextWorkorderId: 1,
      nextWorkorderPartId: 1,
      nextAuditId: 1,
      nextStockMovementId: 1
    },
    users: localUsers,
    parts: [],
    locations: [],
    categories: [],
    transactions: [],
    auditLogs: [],
    stockMovements: [],
    customers: [],
    equipment: [],
    workorders: [],
    workorderParts: []
  }
}

function ensureLocalDbShape(rawDb) {
  const defaults = createDefaultLocalDb()
  return {
    ...defaults,
    ...(rawDb || {}),
    meta: { ...defaults.meta, ...(rawDb?.meta || {}) },
    users: rawDb?.users?.length ? rawDb.users : localUsers,
    parts: rawDb?.parts || [],
    locations: rawDb?.locations || [],
    categories: rawDb?.categories || [],
    transactions: rawDb?.transactions || [],
    auditLogs: rawDb?.auditLogs || [],
    stockMovements: rawDb?.stockMovements || [],
    customers: rawDb?.customers || [],
    equipment: rawDb?.equipment || [],
    workorders: rawDb?.workorders || [],
    workorderParts: rawDb?.workorderParts || []
  }
}

function recalculateMeta(db) {
  db.meta = {
    nextPartId: Math.max(1, ...db.parts.map((item) => Number(item.id) || 0)) + 1,
    nextLocationId: Math.max(1, ...db.locations.map((item) => Number(item.id) || 0)) + 1,
    nextCategoryId: Math.max(1, ...db.categories.map((item) => Number(item.id) || 0)) + 1,
    nextTransactionId: Math.max(1, ...db.transactions.map((item) => Number(item.id) || 0)) + 1,
    nextUserId: Math.max(4, ...db.users.map((item) => Number(item.id) || 0)) + 1,
    nextCustomerId: Math.max(1, ...db.customers.map((item) => Number(item.id) || 0)) + 1,
    nextEquipmentId: Math.max(1, ...db.equipment.map((item) => Number(item.id) || 0)) + 1,
    nextWorkorderId: Math.max(1, ...db.workorders.map((item) => Number(item.id) || 0)) + 1,
    nextWorkorderPartId: Math.max(1, ...db.workorderParts.map((item) => Number(item.id) || 0)) + 1,
    nextAuditId: Math.max(1, ...db.auditLogs.map((item) => Number(item.id) || 0)) + 1,
    nextStockMovementId: Math.max(1, ...db.stockMovements.map((item) => Number(item.id) || 0)) + 1
  }
  return db
}

function loadLocalDb() {
  try {
    const raw = localStorage.getItem(LOCAL_DB_KEY)
    if (!raw) {
      const fresh = createDefaultLocalDb()
      localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(fresh))
      return fresh
    }
    return ensureLocalDbShape(JSON.parse(raw))
  } catch {
    const fresh = createDefaultLocalDb()
    localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(fresh))
    return fresh
  }
}

function saveLocalDb(db) {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db))
}

function withLocalDb(mutator) {
  const db = loadLocalDb()
  const result = mutator(db)
  saveLocalDb(db)
  return result
}

function nextId(meta, key) {
  const value = meta[key]
  meta[key] += 1
  return value
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function mergeImportedDb(baseDb, incomingRaw) {
  const incoming = ensureLocalDbShape(incomingRaw)
  const maps = {
    categories: new Map(),
    locations: new Map(),
    users: new Map(),
    customers: new Map(),
    equipment: new Map(),
    parts: new Map(),
    workorders: new Map()
  }

  for (const category of incoming.categories) {
    const next = { ...category, id: nextId(baseDb.meta, 'nextCategoryId') }
    maps.categories.set(Number(category.id), next.id)
    baseDb.categories.push(next)
  }
  for (const category of baseDb.categories) {
    if (category.parentId) category.parentId = maps.categories.get(Number(category.parentId)) || category.parentId
  }

  for (const location of incoming.locations) {
    const next = { ...location, id: nextId(baseDb.meta, 'nextLocationId') }
    maps.locations.set(Number(location.id), next.id)
    baseDb.locations.push(next)
  }
  for (const location of baseDb.locations) {
    if (location.parentId) location.parentId = maps.locations.get(Number(location.parentId)) || location.parentId
  }

  for (const customer of incoming.customers) {
    const next = { ...customer, id: nextId(baseDb.meta, 'nextCustomerId') }
    maps.customers.set(Number(customer.id), next.id)
    baseDb.customers.push(next)
  }

  for (const equipment of incoming.equipment) {
    const next = {
      ...equipment,
      id: nextId(baseDb.meta, 'nextEquipmentId'),
      customerId: equipment.customerId ? maps.customers.get(Number(equipment.customerId)) || null : null
    }
    maps.equipment.set(Number(equipment.id), next.id)
    baseDb.equipment.push(next)
  }

  for (const part of incoming.parts) {
    const next = {
      ...part,
      id: nextId(baseDb.meta, 'nextPartId'),
      categoryId: part.categoryId ? maps.categories.get(Number(part.categoryId)) || null : null,
      locationId: part.locationId ? maps.locations.get(Number(part.locationId)) || null : null
    }
    maps.parts.set(Number(part.id), next.id)
    baseDb.parts.push(next)
  }

  for (const workorder of incoming.workorders) {
    const next = {
      ...workorder,
      id: nextId(baseDb.meta, 'nextWorkorderId'),
      customerId: workorder.customerId ? maps.customers.get(Number(workorder.customerId)) || null : null,
      equipmentId: workorder.equipmentId ? maps.equipment.get(Number(workorder.equipmentId)) || null : null
    }
    maps.workorders.set(Number(workorder.id), next.id)
    baseDb.workorders.push(next)
  }

  for (const row of incoming.workorderParts) {
    baseDb.workorderParts.push({
      ...row,
      id: nextId(baseDb.meta, 'nextWorkorderPartId'),
      workorderId: maps.workorders.get(Number(row.workorderId)) || null,
      partId: maps.parts.get(Number(row.partId)) || null
    })
  }

  for (const tx of incoming.transactions) {
    baseDb.transactions.push({
      ...tx,
      id: nextId(baseDb.meta, 'nextTransactionId'),
      partId: tx.partId ? maps.parts.get(Number(tx.partId)) || tx.partId : null
    })
  }

  for (const log of incoming.auditLogs) {
    baseDb.auditLogs.push({ ...log, id: nextId(baseDb.meta, 'nextAuditId') })
  }

  for (const movement of incoming.stockMovements) {
    baseDb.stockMovements.push({
      ...movement,
      id: nextId(baseDb.meta, 'nextStockMovementId'),
      partId: movement.partId ? maps.parts.get(Number(movement.partId)) || movement.partId : null
    })
  }

  return recalculateMeta(baseDb)
}

export default function App() {
  const [parts, setParts] = useState([])
  const [locations, setLocations] = useState([])
  const [categories, setCategories] = useState([])
  const [transactions, setTransactions] = useState([])
  const [users, setUsers] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  const [stockMovements, setStockMovements] = useState([])
  const [customers, setCustomers] = useState([])
  const [equipment, setEquipment] = useState([])
  const [workorders, setWorkorders] = useState([])
  const [workorderParts, setWorkorderParts] = useState([])
  const [customerForm, setCustomerForm] = useState(emptyCustomerForm)
  const [equipmentForm, setEquipmentForm] = useState(emptyEquipmentForm)
  const [workorderForm, setWorkorderForm] = useState(emptyWorkorderForm)
  const [workorderPartForm, setWorkorderPartForm] = useState(emptyWorkorderPartForm)
  const [selectedWorkorderId, setSelectedWorkorderId] = useState('')
  const [storageMode, setStorageMode] = useState(() => localStorage.getItem(LOCAL_MODE_KEY) || 'auto')
  const [backendReachable, setBackendReachable] = useState(false)
  const [appPasscode, setAppPasscode] = useState(() => localStorage.getItem(PASSCODE_KEY) || '')
  const [isUnlocked, setIsUnlocked] = useState(() => !localStorage.getItem(PASSCODE_KEY))
  const [unlockPin, setUnlockPin] = useState('')
  const [passcodeForm, setPasscodeForm] = useState(emptyPasscodeForm)
  const [importMode, setImportMode] = useState('merge')
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('inventory:currentUser')
    return saved ? JSON.parse(saved) : null
  })
  const [loginForm, setLoginForm] = useState({ name: 'Owner', pin: '' })
  const [userForm, setUserForm] = useState({ name: '', role: 'tech', pin: '' })
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('inventory')
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
  const importFileRef = useRef(null)

  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationType, setNewLocationType] = useState('bin')
  const [newLocationParentId, setNewLocationParentId] = useState('')

  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryParentId, setNewCategoryParentId] = useState('')
  const API = `${apiBase.replace(/\/$/, '')}/api`
  const ASSET_BASE = apiBase.replace(/\/$/, '')
  const activeMode = storageMode === 'local' || !backendReachable ? 'local' : 'server'
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

  const loadLocalAll = useCallback(() => {
    const db = loadLocalDb()
    const nextParts = db.parts.map((part) => {
      const reservedQty = db.workorderParts.reduce((sum, row) => sum + (Number(row.partId) === Number(part.id) ? Math.max(0, Number(row.qtyReserved || 0) - Number(row.qtyUsed || 0)) : 0), 0)
      return {
        ...part,
        reservedQty,
        availableQty: Number(part.quantity || 0) - reservedQty
      }
    })
    const nextUsers = db.users.map((user) => ({ id: user.id, name: user.name, role: user.role, active: user.active ?? 1 }))
    const nextEquipment = db.equipment.map((item) => ({
      ...item,
      customerName: db.customers.find((customer) => Number(customer.id) === Number(item.customerId))?.name || ''
    }))
    const nextWorkorders = db.workorders.map((workorder) => ({
      ...workorder,
      customerName: db.customers.find((customer) => Number(customer.id) === Number(workorder.customerId))?.name || '',
      equipmentName: db.equipment.find((item) => Number(item.id) === Number(workorder.equipmentId))?.name || ''
    })).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    const activeWorkorderId = selectedWorkorderId || nextWorkorders[0]?.id || ''
    const nextWorkorderParts = activeWorkorderId
      ? db.workorderParts
          .filter((row) => Number(row.workorderId) === Number(activeWorkorderId))
          .map((row) => {
            const part = db.parts.find((item) => Number(item.id) === Number(row.partId))
            return {
              ...row,
              partName: part?.name || 'Unknown part',
              partNumber: part?.partNumber || '',
              quantity: part?.quantity || 0,
              unit: part?.unit || 'each'
            }
          })
      : []

    setParts(nextParts)
    setLocations([...db.locations])
    setCategories([...db.categories])
    setTransactions([...db.transactions].sort((a, b) => Number(b.id) - Number(a.id)))
    setUsers(nextUsers)
    setAuditLogs([...db.auditLogs].sort((a, b) => Number(b.id) - Number(a.id)))
    setStockMovements(
      [...db.stockMovements]
        .map((movement) => ({
          ...movement,
          partName: db.parts.find((part) => Number(part.id) === Number(movement.partId))?.name || 'Unknown part'
        }))
        .sort((a, b) => Number(b.id) - Number(a.id))
    )
    setCustomers([...db.customers])
    setEquipment(nextEquipment)
    setWorkorders(nextWorkorders)
    if (!selectedWorkorderId && activeWorkorderId) setSelectedWorkorderId(String(activeWorkorderId))
    setWorkorderParts(nextWorkorderParts)
  }, [selectedWorkorderId])

  const loadAll = useCallback(async () => {
    if (storageMode === 'local') {
      setBackendReachable(false)
      loadLocalAll()
      return
    }
    try {
      const [p, l, c, t, u, a, m, customersRes, equipmentRes, workordersRes] = await Promise.all([
        fetch(`${API}/parts`),
        fetch(`${API}/locations`),
        fetch(`${API}/categories`),
        fetch(`${API}/transactions`),
        fetch(`${API}/users`),
        fetch(`${API}/audit`),
        fetch(`${API}/stock-movements`),
        fetch(`${API}/customers`),
        fetch(`${API}/equipment`),
        fetch(`${API}/workorders`)
      ])
      if (![p, l, c, t, u, a, m, customersRes, equipmentRes, workordersRes].every((res) => res.ok)) {
        throw new Error('Backend unavailable')
      }

      const nextParts = await p.json()
      const nextWorkorders = await workordersRes.json()
      const activeWorkorderId = selectedWorkorderId || nextWorkorders[0]?.id || ''
      setParts(nextParts)
      setLocations(await l.json())
      setCategories(await c.json())
      setTransactions(await t.json())
      setUsers(await u.json())
      setAuditLogs(await a.json())
      setStockMovements(await m.json())
      setCustomers(await customersRes.json())
      setEquipment(await equipmentRes.json())
      setWorkorders(nextWorkorders)
      setBackendReachable(true)
      if (!selectedWorkorderId && activeWorkorderId) setSelectedWorkorderId(String(activeWorkorderId))
      if (activeWorkorderId) {
        const partsRes = await fetch(`${API}/workorders/${activeWorkorderId}/parts`)
        setWorkorderParts(await partsRes.json())
      } else {
        setWorkorderParts([])
      }
    } catch {
      setBackendReachable(false)
      loadLocalAll()
      setStatus('Backend unavailable. Using local device storage.')
    }
  }, [API, loadLocalAll, selectedWorkorderId, storageMode])

  useEffect(() => {
    Promise.resolve().then(loadAll).catch(() => {
      setStatus('Could not load inventory data.')
    })
    if (storageMode !== 'local') {
      fetch(`${API}/health`)
        .then((res) => res.json())
        .then((data) => {
          setHealth(data)
          setBackendReachable(true)
        })
        .catch(() => {})
    }

    return () => stopCamera()
  }, [API, apiBase, loadAll, storageMode])

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
    if (activeMode === 'local') {
      const user = loadLocalDb().users.find((item) => item.name === loginForm.name && item.pin === loginForm.pin && item.active !== 0)
      if (!user) {
        setStatus('Could not sign in.')
        return
      }
      const safeUser = { id: user.id, name: user.name, role: user.role, active: user.active ?? 1 }
      localStorage.setItem('inventory:currentUser', JSON.stringify(safeUser))
      setCurrentUser(safeUser)
      setLoginForm((current) => ({ ...current, pin: '' }))
      setStatus(`Signed in as ${safeUser.name} on this device.`)
      loadLocalAll()
      return
    }
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
    if (activeMode === 'local') {
      if (!userForm.name.trim() || !userForm.pin.trim()) {
        setStatus('User name and PIN are required.')
        return
      }
      withLocalDb((db) => {
        db.users.push({
          id: nextId(db.meta, 'nextUserId'),
          name: userForm.name.trim(),
          role: userForm.role,
          pin: userForm.pin.trim(),
          active: 1,
          createdAt: nowIso()
        })
      })
      setUserForm({ name: '', role: 'tech', pin: '' })
      setStatus('User added on this device.')
      loadLocalAll()
      return
    }
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

  function updateForm(setter, field, value) {
    setter((current) => ({ ...current, [field]: value }))
  }

  async function addCustomer() {
    if (!canWrite || !customerForm.name.trim()) return
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.customers.push({
          id: nextId(db.meta, 'nextCustomerId'),
          ...customerForm,
          createdAt: nowIso()
        })
      })
      setCustomerForm(emptyCustomerForm)
      setStatus('Customer added on this device.')
      loadLocalAll()
      return
    }
    const res = await apiFetch(`${API}/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customerForm)
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add customer.')
      return
    }
    setCustomerForm(emptyCustomerForm)
    setStatus('Customer added.')
    loadAll()
  }

  async function addEquipment() {
    if (!canWrite || !equipmentForm.name.trim()) return
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.equipment.push({
          id: nextId(db.meta, 'nextEquipmentId'),
          ...equipmentForm,
          customerId: equipmentForm.customerId ? Number(equipmentForm.customerId) : null,
          createdAt: nowIso()
        })
      })
      setEquipmentForm(emptyEquipmentForm)
      setStatus('Equipment added on this device.')
      loadLocalAll()
      return
    }
    const res = await apiFetch(`${API}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...equipmentForm,
        customerId: equipmentForm.customerId ? Number(equipmentForm.customerId) : null
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add equipment.')
      return
    }
    setEquipmentForm(emptyEquipmentForm)
    setStatus('Equipment added.')
    loadAll()
  }

  async function saveWorkorder() {
    if (!canWrite || !workorderForm.title.trim()) return
    if (activeMode === 'local') {
      const created = withLocalDb((db) => {
        const id = nextId(db.meta, 'nextWorkorderId')
        const number = workorderForm.number.trim() || `WO-${String(id).padStart(5, '0')}`
        const record = {
          id,
          ...workorderForm,
          number,
          customerId: workorderForm.customerId ? Number(workorderForm.customerId) : null,
          equipmentId: workorderForm.equipmentId ? Number(workorderForm.equipmentId) : null,
          laborHours: Number(workorderForm.laborHours) || 0,
          laborRate: Number(workorderForm.laborRate) || 0,
          createdAt: nowIso(),
          updatedAt: nowIso()
        }
        db.workorders.push(record)
        return record
      })
      setSelectedWorkorderId(String(created.id))
      setWorkorderPartForm((current) => ({ ...current, workorderId: String(created.id) }))
      setWorkorderForm(emptyWorkorderForm)
      setStatus(`Workorder ${created.number} added on this device.`)
      loadLocalAll()
      return
    }
    const res = await apiFetch(`${API}/workorders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...workorderForm,
        customerId: workorderForm.customerId ? Number(workorderForm.customerId) : null,
        equipmentId: workorderForm.equipmentId ? Number(workorderForm.equipmentId) : null,
        laborHours: Number(workorderForm.laborHours) || 0,
        laborRate: Number(workorderForm.laborRate) || 0
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add workorder.')
      return
    }
    setSelectedWorkorderId(String(data.id))
    setWorkorderPartForm((current) => ({ ...current, workorderId: String(data.id) }))
    setWorkorderForm(emptyWorkorderForm)
    setStatus(`Workorder ${data.number} added.`)
    loadAll()
  }

  async function addWorkorderPart() {
    if (!canWrite) return
    const workorderId = workorderPartForm.workorderId || selectedWorkorderId
    if (!workorderId || !workorderPartForm.partId) {
      setStatus('Choose a workorder and part first.')
      return
    }
    if (activeMode === 'local') {
      const result = withLocalDb((db) => {
        const part = db.parts.find((item) => Number(item.id) === Number(workorderPartForm.partId))
        const workorder = db.workorders.find((item) => Number(item.id) === Number(workorderId))
        if (!part || !workorder) return { error: 'Part or workorder not found.' }
        const qty = Number(workorderPartForm.qty) || 1
        const qtyUsed = workorderPartForm.mode === 'use' ? Math.min(qty, Number(part.quantity || 0)) : 0
        const qtyReserved = workorderPartForm.mode === 'reserve' ? qty : qty
        part.quantity = Math.max(0, Number(part.quantity || 0) - qtyUsed)
        db.workorderParts.push({
          id: nextId(db.meta, 'nextWorkorderPartId'),
          workorderId: Number(workorderId),
          partId: Number(workorderPartForm.partId),
          qtyReserved,
          qtyUsed,
          unitCost: Number(part.unitCost || 0),
          retailPrice: Number(part.retailPrice || 0),
          note: workorderPartForm.note,
          createdAt: nowIso(),
          updatedAt: nowIso()
        })
        workorder.updatedAt = nowIso()
        return { actualUsed: qtyUsed }
      })
      if (result.error) {
        setStatus(result.error)
        return
      }
      setSelectedWorkorderId(String(workorderId))
      setWorkorderPartForm({ ...emptyWorkorderPartForm, workorderId: String(workorderId) })
      setStatus(workorderPartForm.mode === 'use' ? `Used ${result.actualUsed} on local workorder.` : 'Part reserved for local workorder.')
      loadLocalAll()
      return
    }
    const res = await apiFetch(`${API}/workorders/${workorderId}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...workorderPartForm,
        partId: Number(workorderPartForm.partId),
        qty: Number(workorderPartForm.qty) || 1,
        workorderId
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add part to workorder.')
      return
    }
    setSelectedWorkorderId(String(workorderId))
    setWorkorderPartForm({ ...emptyWorkorderPartForm, workorderId: String(workorderId) })
    setStatus(workorderPartForm.mode === 'use' ? `Used ${data.actualUsed} on workorder.` : 'Part reserved for workorder.')
    loadAll()
  }

  async function removeReservedWorkorderPart(id) {
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.workorderParts = db.workorderParts.filter((item) => Number(item.id) !== Number(id))
      })
      setStatus('Reserved part removed.')
      loadLocalAll()
      return
    }
    const res = await apiFetch(`${API}/workorder-parts/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to remove reserved part.')
      return
    }
    setStatus('Reserved part removed.')
    loadAll()
  }

  async function exportSelectedWorkorder() {
    if (!selectedWorkorder) {
      setStatus('Select a workorder to export.')
      return
    }

    if (activeMode === 'local') {
      const db = loadLocalDb()
      const workorder = db.workorders.find((item) => Number(item.id) === Number(selectedWorkorder.id))
      const customer = db.customers.find((item) => Number(item.id) === Number(workorder?.customerId))
      const machine = db.equipment.find((item) => Number(item.id) === Number(workorder?.equipmentId))
      const partRows = db.workorderParts
        .filter((item) => Number(item.workorderId) === Number(selectedWorkorder.id))
        .map((row) => {
          const part = db.parts.find((item) => Number(item.id) === Number(row.partId))
          return {
            ...row,
            partName: part?.name || 'Unknown part',
            partNumber: part?.partNumber || ''
          }
        })
      const partsRetail = partRows.reduce((total, item) => total + Number(item.qtyUsed || 0) * Number(item.retailPrice || 0), 0)
      const partsCost = partRows.reduce((total, item) => total + Number(item.qtyUsed || 0) * Number(item.unitCost || 0), 0)
      const labor = Number(workorder?.laborHours || 0) * Number(workorder?.laborRate || 0)
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${selectedWorkorder.number}</title></head><body><h1>Work Order / Invoice Draft</h1><p>${selectedWorkorder.number}</p><p>${customer?.name || 'No customer'}</p><p>${machine?.name || 'No equipment'}</p><p>${workorder?.complaint || ''}</p><ul>${partRows.map((row) => `<li>${row.partName} x ${row.qtyUsed || row.qtyReserved}</li>`).join('')}</ul><p>Parts retail: $${partsRetail.toFixed(2)}</p><p>Parts cost: $${partsCost.toFixed(2)}</p><p>Labor: $${labor.toFixed(2)}</p><p>Total: $${(partsRetail + labor).toFixed(2)}</p></body></html>`
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const fileName = `${selectedWorkorder.number || `WO-${selectedWorkorder.id}`}-workorder.html`.replace(/[^a-zA-Z0-9._-]/g, '-')
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setStatus('Local workorder export downloaded.')
      return
    }
    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}/export`)
    if (!res.ok) {
      setStatus('Failed to export workorder.')
      return
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const fileName = `${selectedWorkorder.number || `WO-${selectedWorkorder.id}`}-workorder.html`.replace(/[^a-zA-Z0-9._-]/g, '-')
    const link = document.createElement('a')
    link.href = url
    link.download = fileName.endsWith('.html') ? fileName : `${fileName}.html`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setStatus('Workorder export downloaded. Attach it to an email or print it to PDF.')
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

    if (activeMode === 'local') {
      withLocalDb((db) => {
        const payload = toPayload(partForm)
        if (editingId) {
          const row = db.parts.find((item) => Number(item.id) === Number(editingId))
          if (row) Object.assign(row, payload, { updatedAt: nowIso() })
        } else {
          db.parts.push({ id: nextId(db.meta, 'nextPartId'), ...payload, createdAt: nowIso(), updatedAt: nowIso() })
        }
      })
      setPartForm(emptyPartForm)
      setEditingId(null)
      setStatus(editingId ? 'Part updated on this device.' : 'Part added on this device.')
      loadLocalAll()
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

    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.parts = db.parts.filter((item) => Number(item.id) !== Number(id))
        db.workorderParts = db.workorderParts.filter((item) => Number(item.partId) !== Number(id))
      })
      setStatus('Part deleted.')
      loadLocalAll()
      return
    }
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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.locations.push({
          id: nextId(db.meta, 'nextLocationId'),
          name: newLocationName.trim(),
          type: newLocationType,
          parentId: newLocationParentId ? Number(newLocationParentId) : null
        })
      })
      setNewLocationName('')
      setNewLocationType('bin')
      setNewLocationParentId('')
      setStatus('Location added on this device.')
      loadLocalAll()
      return
    }

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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.categories.push({
          id: nextId(db.meta, 'nextCategoryId'),
          name: newCategoryName.trim(),
          parentId: newCategoryParentId ? Number(newCategoryParentId) : null
        })
      })
      setNewCategoryName('')
      setNewCategoryParentId('')
      setStatus('Category added on this device.')
      loadLocalAll()
      return
    }

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

    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.categories = db.categories.filter((item) => Number(item.id) !== Number(id))
        db.parts = db.parts.map((part) => Number(part.categoryId) === Number(id) ? { ...part, categoryId: null } : part)
      })
      setStatus('Category deleted.')
      loadLocalAll()
      return
    }
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

    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.locations = db.locations.filter((item) => Number(item.id) !== Number(id))
        db.parts = db.parts.map((part) => Number(part.locationId) === Number(id) ? { ...part, locationId: null } : part)
      })
      setStatus('Location deleted.')
      loadLocalAll()
      return
    }
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

    if (activeMode === 'local') {
      const result = withLocalDb((db) => {
        const part = db.parts.find((item) => Number(item.id) === Number(id))
        if (!part) return { error: 'Part not found.' }
        const before = Number(part.quantity || 0)
        const delta = action === 'checkout' ? -qty : qty
        const nextQuantity = Math.max(0, before + delta)
        const actualDelta = nextQuantity - before
        part.quantity = nextQuantity
        db.transactions.unshift({
          id: nextId(db.meta, 'nextTransactionId'),
          partId: id,
          type: action,
          qtyChange: actualDelta,
          note: stockNoteById[id] || '',
          workorderRef: stockWorkorderById[id] || '',
          customerRef: stockCustomerById[id] || '',
          equipmentRef: stockEquipmentById[id] || '',
          createdAt: nowIso()
        })
        db.stockMovements.unshift({
          id: nextId(db.meta, 'nextStockMovementId'),
          partId: id,
          movementType: action,
          qtyChange: actualDelta,
          quantityAfter: nextQuantity,
          reason: stockNoteById[id] || '',
          workorderRef: stockWorkorderById[id] || '',
          customerRef: stockCustomerById[id] || '',
          equipmentRef: stockEquipmentById[id] || '',
          userName: currentUser?.name || 'System',
          createdAt: nowIso()
        })
        return {}
      })
      if (result.error) {
        setStatus(result.error)
        return
      }
      setStatus(action === 'checkout' ? `Checked out ${qty}.` : `Returned ${qty}.`)
      setStockNoteById((current) => ({ ...current, [id]: '' }))
      loadLocalAll()
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

    if (activeMode === 'local') {
      const result = withLocalDb((db) => {
        const row = db.parts.find((item) => Number(item.id) === Number(part.id))
        if (!row) return { error: 'Part not found.' }
        const before = Number(row.quantity || 0)
        const qtyChange = quantity - before
        row.quantity = quantity
        db.stockMovements.unshift({
          id: nextId(db.meta, 'nextStockMovementId'),
          partId: part.id,
          movementType: 'count',
          qtyChange,
          quantityAfter: quantity,
          reason: countReason,
          userName: currentUser?.name || 'System',
          createdAt: nowIso()
        })
        return { qtyChange }
      })
      if (result.error) {
        setStatus(result.error)
        return
      }
      setStatus(`Count saved for ${part.name}. Adjustment: ${result.qtyChange > 0 ? '+' : ''}${result.qtyChange}.`)
      setCountQtyById((current) => ({ ...current, [part.id]: '' }))
      loadLocalAll()
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
  const customerMap = useMemo(() => buildMap(customers), [customers])
  const equipmentMap = useMemo(() => buildMap(equipment), [equipment])
  const selectedWorkorder = useMemo(
    () => workorders.find((workorder) => String(workorder.id) === String(selectedWorkorderId)),
    [workorders, selectedWorkorderId]
  )
  const selectedWorkorderTotals = useMemo(() => {
    const partsCost = workorderParts.reduce((total, item) => total + Number(item.qtyUsed || 0) * Number(item.unitCost || 0), 0)
    const partsRetail = workorderParts.reduce((total, item) => total + Number(item.qtyUsed || 0) * Number(item.retailPrice || 0), 0)
    const labor = Number(selectedWorkorder?.laborHours || 0) * Number(selectedWorkorder?.laborRate || 0)
    return {
      partsCost,
      partsRetail,
      labor,
      total: partsRetail + labor,
      margin: partsRetail - partsCost
    }
  }, [workorderParts, selectedWorkorder])

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

    if (activeMode === 'local') {
      withLocalDb((db) => {
        importedParts.forEach((row) => {
          const payload = toPayload({
            ...emptyPartForm,
            ...row
          })
          db.parts.push({
            ...payload,
            id: nextId(db.meta, 'nextPartId'),
            createdAt: nowIso(),
            updatedAt: nowIso()
          })
        })
      })
      setCsvText('')
      setStatus(`Imported ${importedParts.length} parts into local storage.`)
      loadLocalAll()
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
    if (activeMode === 'local') return Promise.resolve(dataUrl)
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
        setStatus(activeMode === 'local' ? 'Photo stored locally.' : 'Photo uploaded.')
      } catch (err) {
        setStatus(err.message)
      }
    }
    reader.readAsDataURL(file)
  }

  function loadEquipmentImage(file, field) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const imageUrl = await uploadDataUrl(String(reader.result || ''), file.name)
        updateForm(setEquipmentForm, field, imageUrl)
        setStatus(field === 'serialPhotoUrl' ? 'Serial number photo stored.' : 'Fleet number photo stored.')
      } catch (err) {
        setStatus(err.message)
      }
    }
    reader.readAsDataURL(file)
  }

  function downloadPartsCsv() {
    if (activeMode === 'local') {
      const header = ['id', ...csvHeaders]
      const csv = [header.join(','), ...parts.map((row) => header.map((field) => csvEscape(row[field])).join(','))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'inventory-parts.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setStatus('Parts CSV downloaded from local storage.')
      return
    }
    window.location.href = `${API}/parts/export`
  }

  function downloadLowStockCsv() {
    if (activeMode === 'local') {
      const header = ['id', ...csvHeaders]
      const csv = [header.join(','), ...lowStockParts.map((row) => header.map((field) => csvEscape(row[field])).join(','))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'low-stock-parts.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setStatus('Low stock CSV downloaded from local storage.')
      return
    }
    window.location.href = `${API}/parts/export/low-stock`
  }

  function downloadBackup() {
    if (activeMode === 'local') {
      const payload = {
        version: 1,
        exportedAt: nowIso(),
        source: 'inventory-local',
        data: recalculateMeta(ensureLocalDbShape(loadLocalDb()))
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `inventory-local-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      const now = nowIso()
      localStorage.setItem('inventory:lastBackupAt', now)
      setLastBackupAt(now)
      setStatus('Local backup downloaded.')
      return
    }
    const now = new Date().toISOString()
    localStorage.setItem('inventory:lastBackupAt', now)
    setLastBackupAt(now)
    setStatus('Backup download started.')
    window.location.href = `${API}/backup`
  }

  function restoreBackup(file) {
    if (!file) return
    if (activeMode === 'local') {
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || '{}'))
          const imported = ensureLocalDbShape(parsed?.data || parsed)
          if (importMode === 'replace') {
            saveLocalDb(recalculateMeta(imported))
            setStatus('Local backup restored.')
          } else {
            const db = loadLocalDb()
            const merged = mergeImportedDb(db, imported)
            saveLocalDb(merged)
            setStatus('Local backup imported and merged.')
          }
          const now = nowIso()
          localStorage.setItem('inventory:lastBackupAt', now)
          setLastBackupAt(now)
          loadLocalAll()
        } catch {
          setStatus('Could not import that local backup file.')
        }
      }
      reader.readAsText(file)
      return
    }
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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        const row = db.categories.find((item) => Number(item.id) === Number(id))
        if (row) {
          row.name = categoryDraft.name
          row.parentId = categoryDraft.parentId ? Number(categoryDraft.parentId) : null
        }
      })
      setEditingCategoryId(null)
      setStatus('Category updated.')
      loadLocalAll()
      return
    }
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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        const row = db.locations.find((item) => Number(item.id) === Number(id))
        if (row) {
          row.name = locationDraft.name
          row.type = locationDraft.type
          row.parentId = locationDraft.parentId ? Number(locationDraft.parentId) : null
        }
      })
      setEditingLocationId(null)
      setStatus('Location updated.')
      loadLocalAll()
      return
    }
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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        const row = db.transactions.find((item) => Number(item.id) === Number(transaction.id))
        if (row) row.note = note
      })
      setStatus('Transaction note updated.')
      loadLocalAll()
      return
    }
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
    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.transactions = db.transactions.filter((item) => Number(item.id) !== Number(transaction.id))
      })
      setStatus('Transaction deleted.')
      loadLocalAll()
      return
    }
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

  function saveStorageMode(nextMode) {
    localStorage.setItem(LOCAL_MODE_KEY, nextMode)
    setStorageMode(nextMode)
    if (nextMode === 'local') {
      setBackendReachable(false)
      setStatus('Offline mode enabled. Using local device storage.')
      loadLocalAll()
    } else {
      setStatus('Auto mode enabled. The app will use the server when available.')
      loadAll()
    }
  }

  function lockAppNow() {
    if (!appPasscode) {
      setStatus('Set an app passcode first.')
      return
    }
    setIsUnlocked(false)
    setUnlockPin('')
    setStatus('App locked.')
  }

  function unlockApp(event) {
    event.preventDefault()
    if (!appPasscode) {
      setIsUnlocked(true)
      return
    }
    if (unlockPin !== appPasscode) {
      setStatus('Wrong app passcode.')
      return
    }
    setIsUnlocked(true)
    setUnlockPin('')
    setStatus('App unlocked.')
  }

  function saveAppPasscode() {
    const nextPasscode = passcodeForm.passcode.trim()
    if (!/^\d{4,8}$/.test(nextPasscode)) {
      setStatus('Use a 4 to 8 digit app passcode.')
      return
    }
    if (nextPasscode !== passcodeForm.confirmPasscode.trim()) {
      setStatus('Passcode confirmation does not match.')
      return
    }
    localStorage.setItem(PASSCODE_KEY, nextPasscode)
    setAppPasscode(nextPasscode)
    setPasscodeForm(emptyPasscodeForm)
    setIsUnlocked(true)
    setStatus('App passcode saved.')
  }

  function clearAppPasscode() {
    if (!appPasscode) {
      setStatus('No app passcode is set.')
      return
    }
    const entered = window.prompt('Enter the current app passcode to remove it:', '') || ''
    if (entered !== appPasscode) {
      setStatus('Passcode was not removed.')
      return
    }
    localStorage.removeItem(PASSCODE_KEY)
    setAppPasscode('')
    setUnlockPin('')
    setIsUnlocked(true)
    setStatus('App passcode removed.')
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
      <input
        ref={importFileRef}
        className="sr-only-input"
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const [file] = e.target.files || []
          restoreBackup(file)
          e.target.value = ''
        }}
      />
      {appPasscode && !isUnlocked && (
        <div className="lock-overlay" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
          <form className="lock-panel" onSubmit={unlockApp}>
            <p className="eyebrow">Inventory</p>
            <h2 id="unlock-title">Unlock this device</h2>
            <p>Enter the local app PIN to keep working on this inventory.</p>
            <label>
              App PIN
              <input
                type="password"
                inputMode="numeric"
                value={unlockPin}
                onChange={(e) => setUnlockPin(e.target.value)}
                autoFocus
              />
            </label>
            <button className="primary-action" type="submit">Unlock</button>
          </form>
        </div>
      )}
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

      <nav className="app-tabs" aria-label="App sections">
        <button className={activeTab === 'inventory' ? 'active-tab' : ''} onClick={() => setActiveTab('inventory')}>
          Inventory
        </button>
        <button className={activeTab === 'workorders' ? 'active-tab' : ''} onClick={() => setActiveTab('workorders')}>
          Workorders
        </button>
        <button className={activeTab === 'admin' ? 'active-tab' : ''} onClick={() => setActiveTab('admin')}>
          Admin
        </button>
      </nav>

      <section className="session-panel">
        {currentUser ? (
          <>
            <div>
              <h2>{currentUser.name}</h2>
              <p>
                {currentUser.role} access is active. {activeMode === 'local' ? 'Working from local device storage.' : 'Connected to the server.'}
              </p>
            </div>
            <div className="session-actions">
              {appPasscode && <button onClick={lockAppNow}>Lock App</button>}
              <button onClick={logout}>Sign Out</button>
            </div>
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

      {activeTab === 'inventory' && (
      <>
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
          <p>
            Export, back up, restore, print labels, and choose whether this app runs from the server or stays on the local device.
          </p>
        </div>
        <div className={backupNeedsAttention() ? 'backup-reminder warn' : 'backup-reminder'}>
          {backupAgeText()}
        </div>
        <div className="ops-grid">
          <label>
            Storage mode
            <select value={storageMode} onChange={(e) => saveStorageMode(e.target.value)}>
              <option value="auto">Auto (server if available)</option>
              <option value="local">Offline / local device only</option>
            </select>
          </label>
          <label>
            Backup import mode
            <select value={importMode} onChange={(e) => setImportMode(e.target.value)}>
              <option value="merge">Merge Into Local Data</option>
              <option value="replace">Replace Local Data</option>
            </select>
          </label>
        </div>
        <div className="ops-actions">
          <button onClick={downloadPartsCsv}>Export CSV</button>
          <button onClick={downloadLowStockCsv}>Export Low Stock</button>
          <button onClick={downloadBackup}>{activeMode === 'local' ? 'Export Local Backup' : 'Download Backup'}</button>
          {activeMode === 'local' ? (
            <button onClick={() => importFileRef.current?.click()}>Import Local Backup</button>
          ) : (
            <label className="restore-picker">
              Restore DB
              <input type="file" accept=".db,.sqlite,application/octet-stream" onChange={(e) => restoreBackup(e.target.files[0])} />
            </label>
          )}
          <button onClick={printLabels}>Print Labels</button>
          <button onClick={installApp}>Install App</button>
        </div>
        <div className="mode-summary">
          <strong>{activeMode === 'local' ? 'Local mode is active.' : 'Server mode is active.'}</strong>
          <span>
            {activeMode === 'local'
              ? 'Customers, stock, labels, photos, and backups stay on this device until you export them.'
              : 'The app is reading and saving against the shared backend.'}
          </span>
        </div>
        <div className="ops-grid">
          <label>
            App lock PIN
            <input
              type="password"
              inputMode="numeric"
              value={passcodeForm.pin}
              onChange={(e) => setPasscodeForm((current) => ({ ...current, pin: e.target.value }))}
              placeholder={appPasscode ? 'Enter new PIN' : 'Set a local app PIN'}
            />
          </label>
          <label>
            Confirm app lock PIN
            <input
              type="password"
              inputMode="numeric"
              value={passcodeForm.confirmPin}
              onChange={(e) => setPasscodeForm((current) => ({ ...current, confirmPin: e.target.value }))}
              placeholder="Confirm PIN"
            />
          </label>
        </div>
        <div className="ops-actions">
          <button onClick={saveAppPasscode}>{appPasscode ? 'Update App Lock' : 'Set App Lock'}</button>
          {appPasscode && <button onClick={lockAppNow}>Lock Now</button>}
          {appPasscode && <button onClick={clearAppPasscode}>Remove App Lock</button>}
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

      {activeTab === 'workorders' && (
      <section className="workorder-panel">
        <div className="panel-title-row">
          <div>
            <h2>Workorders</h2>
            <p>Build jobs, reserve parts, use parts, and draft invoice totals.</p>
          </div>
          <strong>{workorders.filter((workorder) => workorder.status !== 'complete' && workorder.status !== 'invoiced').length} open</strong>
        </div>

        <div className="workorder-layout">
          <div className="panel">
            <h3>Customer Contacts</h3>
            <div className="mini-form stack-form">
              <input placeholder="Customer name" value={customerForm.name} onChange={(e) => updateForm(setCustomerForm, 'name', e.target.value)} />
              <input placeholder="Phone" value={customerForm.phone} onChange={(e) => updateForm(setCustomerForm, 'phone', e.target.value)} />
              <input placeholder="Email" value={customerForm.email} onChange={(e) => updateForm(setCustomerForm, 'email', e.target.value)} />
              <input placeholder="Notes" value={customerForm.notes} onChange={(e) => updateForm(setCustomerForm, 'notes', e.target.value)} />
              <button onClick={addCustomer} disabled={!canWrite}>Add Customer</button>
            </div>
            <div className="compact-list">
              {customers.map((customer) => (
                <div
                  key={customer.id}
                  className={String(workorderForm.customerId) === String(customer.id) ? 'selected-contact' : ''}
                >
                  <span><strong>{customer.name}</strong> {customer.phone && `- ${customer.phone}`}</span>
                  <button onClick={() => {
                    updateForm(setWorkorderForm, 'customerId', String(customer.id))
                    updateForm(setEquipmentForm, 'customerId', String(customer.id))
                  }}>
                    Pick
                  </button>
                </div>
              ))}
              {customers.length === 0 && <div className="empty-state">No customers yet.</div>}
            </div>
          </div>

          <div className="panel">
            <h3>Add Vehicle / Equipment</h3>
            <div className="mini-form stack-form">
              <select value={equipmentForm.customerId} onChange={(e) => updateForm(setEquipmentForm, 'customerId', e.target.value)}>
                <option value="">No Customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.name}</option>
                ))}
              </select>
              <input placeholder="Fleet / unit number" value={equipmentForm.unitNumber} onChange={(e) => updateForm(setEquipmentForm, 'unitNumber', e.target.value)} />
              <input placeholder="Machine name" value={equipmentForm.name} onChange={(e) => updateForm(setEquipmentForm, 'name', e.target.value)} />
              <input placeholder="Brand / make" value={equipmentForm.make} onChange={(e) => updateForm(setEquipmentForm, 'make', e.target.value)} />
              <input placeholder="Model" value={equipmentForm.model} onChange={(e) => updateForm(setEquipmentForm, 'model', e.target.value)} />
              <input placeholder="Year" value={equipmentForm.year} onChange={(e) => updateForm(setEquipmentForm, 'year', e.target.value)} />
              <input placeholder="Serial number" value={equipmentForm.serial} onChange={(e) => updateForm(setEquipmentForm, 'serial', e.target.value)} />
              <input placeholder="VIN" value={equipmentForm.vin} onChange={(e) => updateForm(setEquipmentForm, 'vin', e.target.value)} />
              <label className="restore-picker">
                Serial # Photo
                <input type="file" accept="image/*" capture="environment" onChange={(e) => loadEquipmentImage(e.target.files[0], 'serialPhotoUrl')} />
              </label>
              <label className="restore-picker">
                Fleet # Photo
                <input type="file" accept="image/*" capture="environment" onChange={(e) => loadEquipmentImage(e.target.files[0], 'fleetPhotoUrl')} />
              </label>
              <button onClick={addEquipment} disabled={!canWrite}>Add Equipment</button>
            </div>
            {(equipmentForm.serialPhotoUrl || equipmentForm.fleetPhotoUrl) && (
              <div className="intake-photo-row">
                {equipmentForm.serialPhotoUrl && <img src={assetUrl(equipmentForm.serialPhotoUrl)} alt="" />}
                {equipmentForm.fleetPhotoUrl && <img src={assetUrl(equipmentForm.fleetPhotoUrl)} alt="" />}
              </div>
            )}
            <div className="compact-list">
              {equipment.slice(0, 4).map((item) => (
                <div key={item.id}>
                  <span><strong>{item.name}</strong> {item.customerName && `- ${item.customerName}`}</span>
                </div>
              ))}
              {equipment.length === 0 && <div className="empty-state">No equipment yet.</div>}
            </div>
          </div>

          <div className="panel wide-panel">
            <h3>Add Workorder</h3>
            <div className="field-grid">
              <label>
                Number
                <input placeholder="Auto if blank" value={workorderForm.number} onChange={(e) => updateForm(setWorkorderForm, 'number', e.target.value)} />
              </label>
              <label>
                Title
                <input value={workorderForm.title} onChange={(e) => updateForm(setWorkorderForm, 'title', e.target.value)} />
              </label>
              <label>
                Status
                <select value={workorderForm.status} onChange={(e) => updateForm(setWorkorderForm, 'status', e.target.value)}>
                  <option value="open">Open</option>
                  <option value="in progress">In Progress</option>
                  <option value="waiting parts">Waiting Parts</option>
                  <option value="complete">Complete</option>
                  <option value="invoiced">Invoiced</option>
                </select>
              </label>
              <label>
                Customer
                <select value={workorderForm.customerId} onChange={(e) => updateForm(setWorkorderForm, 'customerId', e.target.value)}>
                  <option value="">No Customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Equipment
                <select value={workorderForm.equipmentId} onChange={(e) => updateForm(setWorkorderForm, 'equipmentId', e.target.value)}>
                  <option value="">No Equipment</option>
                  {equipment
                    .filter((item) => !workorderForm.customerId || String(item.customerId) === String(workorderForm.customerId))
                    .map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                </select>
              </label>
              <label>
                Labor hours
                <input type="number" min="0" step="0.1" value={workorderForm.laborHours} onChange={(e) => updateForm(setWorkorderForm, 'laborHours', e.target.value)} />
              </label>
              <label>
                Labor rate
                <input type="number" min="0" step="0.01" value={workorderForm.laborRate} onChange={(e) => updateForm(setWorkorderForm, 'laborRate', e.target.value)} />
              </label>
              <label className="full-field">
                Complaint
                <input value={workorderForm.complaint} onChange={(e) => updateForm(setWorkorderForm, 'complaint', e.target.value)} />
              </label>
              <label className="full-field">
                Diagnosis / labor notes
                <textarea value={workorderForm.diagnosis} onChange={(e) => updateForm(setWorkorderForm, 'diagnosis', e.target.value)} />
              </label>
            </div>
            <button className="primary-action" onClick={saveWorkorder} disabled={!canWrite}>Add Workorder</button>
          </div>
        </div>

        <div className="workorder-detail">
          <div className="panel">
            <h3>Open Jobs</h3>
            <div className="compact-list">
              {workorders.slice(0, 8).map((workorder) => (
                <button
                  key={workorder.id}
                  className={String(selectedWorkorderId) === String(workorder.id) ? 'selected-row' : ''}
                  onClick={() => {
                    setSelectedWorkorderId(String(workorder.id))
                    setWorkorderPartForm((current) => ({ ...current, workorderId: String(workorder.id) }))
                  }}
                >
                  {workorder.number} - {workorder.title} ({workorder.status})
                </button>
              ))}
              {workorders.length === 0 && <div className="empty-state">No workorders yet.</div>}
            </div>
          </div>

          <div className="panel wide-panel">
            <div className="panel-title-row">
              <h3>{selectedWorkorder ? `${selectedWorkorder.number} - ${selectedWorkorder.title}` : 'Workorder Detail'}</h3>
              {selectedWorkorder && (
                <div className="label-actions">
                  <strong>{selectedWorkorder.status}</strong>
                  <button onClick={exportSelectedWorkorder}>Export for Email</button>
                </div>
              )}
            </div>
            {selectedWorkorder ? (
              <>
                <div className="part-meta">
                  <span>Customer: {customerMap[selectedWorkorder.customerId]?.name || selectedWorkorder.customerName || 'None'}</span>
                  <span>Equipment: {equipmentMap[selectedWorkorder.equipmentId]?.name || selectedWorkorder.equipmentName || 'None'}</span>
                  <span>Parts retail: ${selectedWorkorderTotals.partsRetail.toFixed(2)}</span>
                  <span>Labor: ${selectedWorkorderTotals.labor.toFixed(2)}</span>
                  <span>Total draft: ${selectedWorkorderTotals.total.toFixed(2)}</span>
                  <span>Parts margin: ${selectedWorkorderTotals.margin.toFixed(2)}</span>
                </div>
                <div className="mini-form workorder-part-form">
                  <select value={workorderPartForm.partId} onChange={(e) => updateForm(setWorkorderPartForm, 'partId', e.target.value)}>
                    <option value="">Choose Part</option>
                    {parts.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name} - avail {part.availableQty ?? part.quantity}
                      </option>
                    ))}
                  </select>
                  <input type="number" min="1" value={workorderPartForm.qty} onChange={(e) => updateForm(setWorkorderPartForm, 'qty', e.target.value)} />
                  <select value={workorderPartForm.mode} onChange={(e) => updateForm(setWorkorderPartForm, 'mode', e.target.value)}>
                    <option value="reserve">Reserve</option>
                    <option value="use">Use Now</option>
                  </select>
                  <input placeholder="Note" value={workorderPartForm.note} onChange={(e) => updateForm(setWorkorderPartForm, 'note', e.target.value)} />
                  <button onClick={addWorkorderPart} disabled={!canWrite}>Add Part</button>
                </div>
                <div className="compact-list">
                  {workorderParts.map((item) => (
                    <div key={item.id}>
                      <span>
                        <strong>{item.partName}</strong> - reserved {item.qtyReserved}, used {item.qtyUsed}
                      </span>
                      <span>${(Number(item.qtyUsed || 0) * Number(item.retailPrice || 0)).toFixed(2)}</span>
                      {Number(item.qtyUsed || 0) === 0 && (
                        <button className="danger-button" onClick={() => removeReservedWorkorderPart(item.id)} disabled={!canWrite}>Remove</button>
                      )}
                    </div>
                  ))}
                  {workorderParts.length === 0 && <div className="empty-state">No parts on this workorder yet.</div>}
                </div>
              </>
            ) : (
              <div className="empty-state">Select or create a workorder.</div>
            )}
          </div>

          <div className="panel invoice-draft">
            <h3>Invoice Draft</h3>
            {selectedWorkorder ? (
              <>
                <p><strong>{selectedWorkorder.number}</strong></p>
                <p>{customerMap[selectedWorkorder.customerId]?.name || selectedWorkorder.customerName || 'No customer'}</p>
                <p>{equipmentMap[selectedWorkorder.equipmentId]?.name || selectedWorkorder.equipmentName || 'No equipment'}</p>
                <div className="invoice-line"><span>Parts</span><strong>${selectedWorkorderTotals.partsRetail.toFixed(2)}</strong></div>
                <div className="invoice-line"><span>Labor</span><strong>${selectedWorkorderTotals.labor.toFixed(2)}</strong></div>
                <div className="invoice-total"><span>Total</span><strong>${selectedWorkorderTotals.total.toFixed(2)}</strong></div>
              </>
            ) : (
              <div className="empty-state">No workorder selected.</div>
            )}
          </div>
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
                  <span>Available: {p.availableQty ?? p.quantity}</span>
                  <span>Reserved: {p.reservedQty || 0}</span>
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
      </>
      )}

      {activeTab === 'admin' && (
      <>
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
      </>
      )}
    </main>
  )
}
