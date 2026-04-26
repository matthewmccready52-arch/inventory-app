import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'

const host = window.location.hostname || 'localhost'
const defaultApiBase = `http://${host}:3001`
const LOCAL_DB_KEY = 'workorders:offline-db'
const LOCAL_MODE_KEY = 'workorders:storageMode'
const PASSCODE_KEY = 'workorders:appPasscode'

const localUsers = [
  { id: 1, name: 'Owner', role: 'owner', pin: '1234' },
  { id: 2, name: 'Tech', role: 'tech', pin: '2468' },
  { id: 3, name: 'Viewer', role: 'viewer', pin: '0000' }
]

const emptyLogin = { name: 'Owner', pin: '' }
const emptyCustomer = { name: '', phone: '', email: '', notes: '' }
const emptyMachine = {
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
const emptyWorkorder = {
  number: '',
  title: '',
  status: 'open',
  customerId: '',
  equipmentId: '',
  complaint: '',
  diagnosis: '',
  laborNotes: '',
  laborHours: 0,
  laborRate: 0,
  laborStartedAt: '',
  laborAccumulatedMs: 0,
  customerSignatureDataUrl: '',
  customerSignatureName: '',
  customerSignedAt: ''
}
const emptyWorkorderPart = { partId: '', qty: 1, mode: 'reserve', note: '' }
const emptyLocalPart = { name: '', partNumber: '', quantity: 1, unitCost: 0, retailPrice: 0 }
const emptyPasscodeForm = { passcode: '', confirmPasscode: '' }
const statusOptions = ['open', 'in progress', 'quote pending', 'waiting parts', 'complete', 'invoiced', 'picked up']

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function formatCurrency(value) {
  return `$${(Number(value) || 0).toFixed(2)}`
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function normalizeWorkorderForForm(workorder) {
  if (!workorder) return emptyWorkorder
  return {
    number: workorder.number || '',
    title: workorder.title || '',
    status: workorder.status || 'open',
    customerId: workorder.customerId ? String(workorder.customerId) : '',
    equipmentId: workorder.equipmentId ? String(workorder.equipmentId) : '',
    complaint: workorder.complaint || '',
    diagnosis: workorder.diagnosis || '',
    laborNotes: workorder.laborNotes || '',
    laborHours: Number(workorder.laborHours || 0),
    laborRate: Number(workorder.laborRate || 0),
    laborStartedAt: workorder.laborStartedAt || '',
    laborAccumulatedMs: Number(workorder.laborAccumulatedMs || 0),
    customerSignatureDataUrl: workorder.customerSignatureDataUrl || '',
    customerSignatureName: workorder.customerSignatureName || '',
    customerSignedAt: workorder.customerSignedAt || ''
  }
}

function parseMachineSpeech(text) {
  const next = {}
  const patterns = [
    ['unitNumber', /(fleet|unit)\s*(number)?\s*([a-z0-9-]+)/i, 3],
    ['serial', /serial\s*(number)?\s*([a-z0-9-]+)/i, 2],
    ['vin', /\bvin\s*([a-z0-9-]+)/i, 1],
    ['make', /(make|brand)\s*([a-z0-9-]+)/i, 2],
    ['model', /model\s*([a-z0-9-]+)/i, 1],
    ['year', /year\s*(20\d{2}|19\d{2})/i, 1]
  ]

  for (const [field, pattern, group] of patterns) {
    const match = text.match(pattern)
    if (match?.[group]) next[field] = match[group]
  }

  if (!next.name && next.make && next.model) next.name = `${next.make} ${next.model}`
  return next
}

function parseWorkorderSpeech(text) {
  const next = {}
  const statusMatch = text.match(/\b(open|in progress|quote pending|waiting parts|complete|invoiced|picked up)\b/i)
  if (statusMatch) next.status = statusMatch[1].toLowerCase()
  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr)\b/i)
  if (hoursMatch) next.laborHours = Number(hoursMatch[1])
  const rateMatch = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(per hour|hourly|an hour)/i)
  if (rateMatch) next.laborRate = Number(rateMatch[1])
  return next
}

function computeLaborMs(workorder) {
  const accumulated = Number(workorder?.laborAccumulatedMs || 0)
  if (!workorder?.laborStartedAt) return accumulated
  const startedAt = new Date(workorder.laborStartedAt).getTime()
  if (!Number.isFinite(startedAt)) return accumulated
  return Math.max(0, accumulated + (Date.now() - startedAt))
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function createDefaultLocalDb() {
  return {
    meta: {
      nextCustomerId: 1,
      nextEquipmentId: 1,
      nextPartId: 1,
      nextWorkorderId: 1,
      nextWorkorderPartId: 1
    },
    users: localUsers,
    customers: [],
    equipment: [],
    parts: [],
    workorders: [],
    workorderParts: []
  }
}

function ensureLocalDbShape(rawDb) {
  return {
    ...createDefaultLocalDb(),
    ...(rawDb || {}),
    meta: { ...createDefaultLocalDb().meta, ...(rawDb?.meta || {}) },
    users: rawDb?.users?.length ? rawDb.users : localUsers,
    customers: rawDb?.customers || [],
    equipment: rawDb?.equipment || [],
    parts: rawDb?.parts || [],
    workorders: rawDb?.workorders || [],
    workorderParts: rawDb?.workorderParts || []
  }
}

function recalculateMeta(db) {
  db.meta = {
    nextCustomerId: Math.max(1, ...db.customers.map((item) => Number(item.id) || 0)) + 1,
    nextEquipmentId: Math.max(1, ...db.equipment.map((item) => Number(item.id) || 0)) + 1,
    nextPartId: Math.max(1, ...db.parts.map((item) => Number(item.id) || 0)) + 1,
    nextWorkorderId: Math.max(1, ...db.workorders.map((item) => Number(item.id) || 0)) + 1,
    nextWorkorderPartId: Math.max(1, ...db.workorderParts.map((item) => Number(item.id) || 0)) + 1
  }
  return db
}

function mergeImportedDb(baseDb, incomingDb) {
  const incoming = ensureLocalDbShape(incomingDb)
  const customerMap = new Map()
  const equipmentMap = new Map()
  const partMap = new Map()
  const workorderMap = new Map()

  for (const customer of incoming.customers) {
    const next = { ...customer, id: nextId(baseDb.meta, 'nextCustomerId') }
    customerMap.set(Number(customer.id), next.id)
    baseDb.customers.push(next)
  }

  for (const equipment of incoming.equipment) {
    const next = {
      ...equipment,
      id: nextId(baseDb.meta, 'nextEquipmentId'),
      customerId: equipment.customerId ? customerMap.get(Number(equipment.customerId)) || null : null
    }
    equipmentMap.set(Number(equipment.id), next.id)
    baseDb.equipment.push(next)
  }

  for (const part of incoming.parts) {
    const next = { ...part, id: nextId(baseDb.meta, 'nextPartId') }
    partMap.set(Number(part.id), next.id)
    baseDb.parts.push(next)
  }

  for (const workorder of incoming.workorders) {
    const next = {
      ...workorder,
      id: nextId(baseDb.meta, 'nextWorkorderId'),
      customerId: workorder.customerId ? customerMap.get(Number(workorder.customerId)) || null : null,
      equipmentId: workorder.equipmentId ? equipmentMap.get(Number(workorder.equipmentId)) || null : null
    }
    workorderMap.set(Number(workorder.id), next.id)
    baseDb.workorders.push(next)
  }

  for (const row of incoming.workorderParts) {
    baseDb.workorderParts.push({
      ...row,
      id: nextId(baseDb.meta, 'nextWorkorderPartId'),
      workorderId: workorderMap.get(Number(row.workorderId)) || null,
      partId: partMap.get(Number(row.partId)) || null
    })
  }

  return recalculateMeta(baseDb)
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

function getReservedQtyForPart(db, partId) {
  return db.workorderParts.reduce((sum, row) => sum + Math.max(0, Number(row.partId) === Number(partId) ? Number(row.qtyReserved || 0) - Number(row.qtyUsed || 0) : 0), 0)
}

function buildLocalParts(db) {
  return db.parts.map((part) => {
    const reservedQty = getReservedQtyForPart(db, part.id)
    return {
      ...part,
      reservedQty,
      availableQty: Number(part.quantity || 0) - reservedQty
    }
  })
}

function buildLocalWorkorders(db) {
  return db.workorders.map((workorder) => {
    const customer = db.customers.find((item) => Number(item.id) === Number(workorder.customerId))
    const machine = db.equipment.find((item) => Number(item.id) === Number(workorder.equipmentId))
    const workorderRows = db.workorderParts.filter((row) => Number(row.workorderId) === Number(workorder.id))
    const partsCost = workorderRows.reduce((sum, row) => sum + Number(row.qtyUsed || 0) * Number(row.unitCost || 0), 0)
    const partsRetail = workorderRows.reduce((sum, row) => sum + Number(row.qtyUsed || 0) * Number(row.retailPrice || 0), 0)
    const reservedCount = workorderRows.reduce((sum, row) => sum + Number(row.qtyReserved || 0), 0)
    const usedCount = workorderRows.reduce((sum, row) => sum + Number(row.qtyUsed || 0), 0)
    return {
      ...workorder,
      customerName: customer?.name || '',
      equipmentName: machine?.name || '',
      partsCost,
      partsRetail,
      reservedCount,
      usedCount
    }
  }).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
}

function buildLocalWorkorderBundle(db, workorderId) {
  const workorder = db.workorders.find((item) => Number(item.id) === Number(workorderId))
  if (!workorder) return null
  const customer = db.customers.find((item) => Number(item.id) === Number(workorder.customerId))
  const machine = db.equipment.find((item) => Number(item.id) === Number(workorder.equipmentId))
  const partRows = db.workorderParts
    .filter((row) => Number(row.workorderId) === Number(workorder.id))
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
    .sort((a, b) => Number(b.id) - Number(a.id))

  return {
    detail: {
      ...workorder,
      customerName: customer?.name || '',
      customerPhone: customer?.phone || '',
      customerEmail: customer?.email || '',
      customerNotes: customer?.notes || '',
      equipmentName: machine?.name || '',
      equipmentMake: machine?.make || '',
      equipmentModel: machine?.model || '',
      equipmentSerial: machine?.serial || '',
      equipmentUnitNumber: machine?.unitNumber || ''
    },
    parts: partRows,
    customerHistory: db.workorders
      .filter((item) => Number(item.customerId) === Number(workorder.customerId) && Number(item.id) !== Number(workorder.id))
      .map((item) => ({
        ...item,
        equipmentName: db.equipment.find((eq) => Number(eq.id) === Number(item.equipmentId))?.name || ''
      }))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)),
    equipmentHistory: db.workorders
      .filter((item) => Number(item.equipmentId) === Number(workorder.equipmentId) && Number(item.id) !== Number(workorder.id))
      .map((item) => ({
        ...item,
        customerName: db.customers.find((c) => Number(c.id) === Number(item.customerId))?.name || ''
      }))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
  }
}

function nextId(meta, key) {
  const value = meta[key]
  meta[key] += 1
  return value
}

function nowIso() {
  return new Date().toISOString()
}

function buildWorkorderHtml(workorder, customer, machine, partRows, originLabel = 'Local device storage') {
  const partsRetail = partRows.reduce((sum, row) => sum + Number(row.qtyUsed || 0) * Number(row.retailPrice || 0), 0)
  const partsCost = partRows.reduce((sum, row) => sum + Number(row.qtyUsed || 0) * Number(row.unitCost || 0), 0)
  const billedLaborHours = Math.max(Number(workorder.laborHours || 0), computeLaborMs(workorder) / 3600000)
  const laborTotal = billedLaborHours * Number(workorder.laborRate || 0)
  const grandTotal = partsRetail + laborTotal
  const partsRows = partRows.length
    ? partRows.map((part) => `
      <tr>
        <td>${htmlEscape(part.qtyUsed || part.qtyReserved || 0)}</td>
        <td>${htmlEscape(part.partNumber || '')}</td>
        <td>${htmlEscape(part.partName || 'Unknown part')}${part.note ? `<br><small>${htmlEscape(part.note)}</small>` : ''}</td>
        <td class="num">${formatCurrency(part.retailPrice)}</td>
        <td class="num">${formatCurrency(Number(part.qtyUsed || 0) * Number(part.retailPrice || 0))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">No parts recorded.</td></tr>'

  const photos = [machine?.serialPhotoUrl, machine?.fleetPhotoUrl].filter(Boolean).map((src, index) => `
    <figure>
      <img src="${htmlEscape(src)}" alt="">
      <figcaption>${index === 0 ? 'Serial number photo' : 'Fleet/unit number photo'}</figcaption>
    </figure>
  `).join('')

  const signatureBlock = workorder.customerSignatureDataUrl
    ? `
      <div>
        <img src="${htmlEscape(workorder.customerSignatureDataUrl)}" alt="Customer signature">
        <div class="signature-meta">${htmlEscape(workorder.customerSignatureName || 'Customer')}</div>
        <div class="signature-meta">${htmlEscape(workorder.customerSignedAt || '')}</div>
      </div>`
    : '<div class="line">Customer Signature</div>'

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(workorder.number)} Workorder</title>
  <style>
    body { color: #111; font-family: Arial, sans-serif; line-height: 1.35; margin: 28px; }
    header { align-items: start; border-bottom: 3px solid #111; display: flex; justify-content: space-between; padding-bottom: 12px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; }
    h2 { border-bottom: 1px solid #bbb; font-size: 17px; margin: 24px 0 8px; padding-bottom: 4px; }
    .muted { color: #555; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .box { border: 1px solid #bbb; border-radius: 6px; padding: 10px; }
    table { border-collapse: collapse; margin-top: 8px; width: 100%; }
    th, td { border: 1px solid #aaa; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #eee; }
    .num { text-align: right; }
    .totals { margin-left: auto; max-width: 360px; }
    .totals div { display: flex; justify-content: space-between; padding: 6px 0; }
    .grand { border-top: 2px solid #111; font-size: 20px; font-weight: 700; }
    .photos { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    figure { margin: 0; }
    img { border: 1px solid #aaa; max-height: 260px; max-width: 100%; object-fit: contain; }
    figcaption { color: #555; font-size: 12px; margin-top: 4px; }
    .signatures { display: grid; gap: 30px; grid-template-columns: repeat(2, 1fr); margin-top: 34px; }
    .line { border-top: 1px solid #111; padding-top: 5px; }
    .signature-meta { color: #555; font-size: 12px; margin-top: 4px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Work Order / Invoice Draft</h1>
      <p class="muted">Generated ${htmlEscape(new Date().toLocaleString())}</p>
      <p class="muted">${htmlEscape(originLabel)}</p>
    </div>
    <div>
      <h2>${htmlEscape(workorder.number)}</h2>
      <p>Status: ${htmlEscape(workorder.status)}</p>
      <p>Date In: ${htmlEscape(workorder.createdAt || '')}</p>
    </div>
  </header>
  <section class="grid">
    <div class="box">
      <h2>Customer</h2>
      <p><strong>${htmlEscape(customer?.name || 'No customer')}</strong></p>
      <p>${htmlEscape(customer?.phone || '')}</p>
      <p>${htmlEscape(customer?.email || '')}</p>
      <p>${htmlEscape(customer?.notes || '')}</p>
    </div>
    <div class="box">
      <h2>Machine</h2>
      <p><strong>${htmlEscape(machine?.name || 'No equipment')}</strong></p>
      <p>${htmlEscape([machine?.year, machine?.make, machine?.model].filter(Boolean).join(' '))}</p>
      <p>Fleet/Unit: ${htmlEscape(machine?.unitNumber || '')}</p>
      <p>Serial: ${htmlEscape(machine?.serial || '')}</p>
      <p>VIN: ${htmlEscape(machine?.vin || '')}</p>
      <p>Hours/Mileage: ${htmlEscape([machine?.hours, machine?.mileage].filter(Boolean).join(' / '))}</p>
    </div>
  </section>
  <h2>Drop-Off / Complaint</h2>
  <div class="box">${htmlEscape(workorder.complaint || '').replace(/\n/g, '<br>') || 'No complaint recorded.'}</div>
  <h2>Diagnosis / Work Notes</h2>
  <div class="box">${htmlEscape(workorder.diagnosis || workorder.laborNotes || '').replace(/\n/g, '<br>') || 'No notes recorded.'}</div>
  ${photos ? `<h2>Machine Intake Photos</h2><div class="photos">${photos}</div>` : ''}
  <h2>Parts Replaced / Parts Used</h2>
  <table>
    <thead><tr><th>Qty</th><th>Part # / Code</th><th>Description</th><th class="num">Retail</th><th class="num">Line Total</th></tr></thead>
    <tbody>${partsRows}</tbody>
  </table>
  <h2>Labor / Totals</h2>
  <div class="totals">
    <div><span>Parts Retail</span><strong>${formatCurrency(partsRetail)}</strong></div>
    <div><span>Labor (${htmlEscape(billedLaborHours.toFixed(2))} hrs @ ${formatCurrency(workorder.laborRate)})</span><strong>${formatCurrency(laborTotal)}</strong></div>
    <div><span>Parts Cost</span><span>${formatCurrency(partsCost)}</span></div>
    <div class="grand"><span>Total</span><strong>${formatCurrency(grandTotal)}</strong></div>
  </div>
  <div class="signatures">
    ${signatureBlock}
    <div class="line">Technician</div>
  </div>
</body>
</html>`
}

export default function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('workorders:apiBase') || defaultApiBase)
  const [storageMode, setStorageMode] = useState(() => localStorage.getItem(LOCAL_MODE_KEY) || 'auto')
  const [status, setStatus] = useState('')
  const [users, setUsers] = useState([])
  const [customers, setCustomers] = useState([])
  const [equipment, setEquipment] = useState([])
  const [parts, setParts] = useState([])
  const [workorders, setWorkorders] = useState([])
  const [workorderParts, setWorkorderParts] = useState([])
  const [customerHistory, setCustomerHistory] = useState([])
  const [equipmentHistory, setEquipmentHistory] = useState([])
  const [searchText, setSearchText] = useState('')
  const [signatureName, setSignatureName] = useState('')
  const [backendReachable, setBackendReachable] = useState(false)
  const [appPasscode, setAppPasscode] = useState(() => localStorage.getItem(PASSCODE_KEY) || '')
  const [isUnlocked, setIsUnlocked] = useState(() => !localStorage.getItem(PASSCODE_KEY))
  const [unlockPin, setUnlockPin] = useState('')
  const [passcodeForm, setPasscodeForm] = useState(emptyPasscodeForm)
  const [importMode, setImportMode] = useState('merge')
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('workorders:currentUser')
    return saved ? JSON.parse(saved) : null
  })
  const [loginForm, setLoginForm] = useState(emptyLogin)
  const [customerForm, setCustomerForm] = useState(emptyCustomer)
  const [machineForm, setMachineForm] = useState(emptyMachine)
  const [workorderForm, setWorkorderForm] = useState(emptyWorkorder)
  const [partForm, setPartForm] = useState(emptyWorkorderPart)
  const [localPartForm, setLocalPartForm] = useState(emptyLocalPart)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [selectedWorkorderId, setSelectedWorkorderId] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [dictatingField, setDictatingField] = useState('')
  const [isSignatureDirty, setIsSignatureDirty] = useState(false)
  const [liveTimerMs, setLiveTimerMs] = useState(0)
  const recognitionRef = useRef(null)
  const signatureCanvasRef = useRef(null)
  const drawingRef = useRef(false)
  const importFileRef = useRef(null)
  const API = `${apiBase.replace(/\/$/, '')}/api`
  const ASSET_BASE = apiBase.replace(/\/$/, '')
  const activeMode = storageMode === 'local' || !backendReachable ? 'local' : 'server'
  const canWrite = currentUser && ['owner', 'tech'].includes(currentUser.role)

  function authHeaders(extra = {}) {
    return currentUser ? { ...extra, 'x-user-id': String(currentUser.id) } : extra
  }

  function updateForm(setter, field, value) {
    setter((current) => ({ ...current, [field]: value }))
  }

  function assetUrl(src) {
    if (!src) return ''
    return src.startsWith('/uploads/') ? `${ASSET_BASE}${src}` : src
  }

  async function apiFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: authHeaders(options.headers || {})
    })
  }

  const loadLocalAll = useCallback(() => {
    const db = loadLocalDb()
    const nextUsers = db.users.map((user) => ({ id: user.id, name: user.name, role: user.role }))
    const nextCustomers = [...db.customers].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const nextEquipment = db.equipment.map((item) => ({
      ...item,
      customerName: db.customers.find((customer) => Number(customer.id) === Number(item.customerId))?.name || ''
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const nextParts = buildLocalParts(db).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const nextWorkorders = buildLocalWorkorders(db)

    setUsers(nextUsers)
    setCustomers(nextCustomers)
    setEquipment(nextEquipment)
    setParts(nextParts)
    setWorkorders(nextWorkorders)

    if (!selectedCustomerId && nextCustomers[0]) setSelectedCustomerId(String(nextCustomers[0].id))
    if (!selectedWorkorderId && nextWorkorders[0]) setSelectedWorkorderId(String(nextWorkorders[0].id))
  }, [selectedCustomerId, selectedWorkorderId])

  const loadAll = useCallback(async () => {
    if (storageMode === 'local') {
      setBackendReachable(false)
      loadLocalAll()
      return
    }

    try {
      const [usersRes, customersRes, equipmentRes, partsRes, workordersRes] = await Promise.all([
        fetch(`${API}/users`),
        fetch(`${API}/customers`),
        fetch(`${API}/equipment`),
        fetch(`${API}/parts`),
        fetch(`${API}/workorders`)
      ])
      if (![usersRes, customersRes, equipmentRes, partsRes, workordersRes].every((res) => res.ok)) {
        throw new Error('Backend did not respond cleanly.')
      }

      const nextUsers = await usersRes.json()
      const nextCustomers = await customersRes.json()
      const nextEquipment = await equipmentRes.json()
      const nextParts = await partsRes.json()
      const nextWorkorders = await workordersRes.json()

      setUsers(nextUsers)
      setCustomers(nextCustomers)
      setEquipment(nextEquipment)
      setParts(nextParts)
      setWorkorders(nextWorkorders)
      setBackendReachable(true)

      if (!selectedCustomerId && nextCustomers[0]) setSelectedCustomerId(String(nextCustomers[0].id))
      if (!selectedWorkorderId && nextWorkorders[0]) setSelectedWorkorderId(String(nextWorkorders[0].id))
    } catch {
      setBackendReachable(false)
      loadLocalAll()
      setStatus('Backend unavailable. Using local device storage.')
    }
  }, [API, loadLocalAll, selectedCustomerId, selectedWorkorderId, storageMode])

  const loadSelectedWorkorderData = useCallback(async (workorderId) => {
    if (!workorderId) {
      setWorkorderParts([])
      setCustomerHistory([])
      setEquipmentHistory([])
      return
    }

    if (activeMode === 'local') {
      const bundle = buildLocalWorkorderBundle(loadLocalDb(), workorderId)
      if (!bundle) return
      setWorkorderParts(bundle.parts)
      setCustomerHistory(bundle.customerHistory)
      setEquipmentHistory(bundle.equipmentHistory)
      setWorkorderForm(normalizeWorkorderForForm(bundle.detail))
      setSignatureName(bundle.detail.customerSignatureName || bundle.detail.customerName || '')
      setLiveTimerMs(Number(bundle.detail.laborAccumulatedMs || 0))
      return
    }

    try {
      const detailRes = await fetch(`${API}/workorders/${workorderId}`)
      if (!detailRes.ok) return
      const detail = await detailRes.json()
      const requests = [fetch(`${API}/workorders/${workorderId}/parts`)]
      if (detail.customerId) requests.push(fetch(`${API}/customers/${detail.customerId}/workorders`))
      if (detail.equipmentId) requests.push(fetch(`${API}/equipment/${detail.equipmentId}/workorders`))
      const responses = await Promise.all(requests)
      const partsData = await responses[0].json()
      const customerData = responses[1] ? await responses[1].json() : []
      const equipmentData = responses[2] ? await responses[2].json() : []
      setWorkorderParts(partsData)
      setCustomerHistory(customerData.filter((item) => String(item.id) !== String(workorderId)))
      setEquipmentHistory(equipmentData.filter((item) => String(item.id) !== String(workorderId)))
      setWorkorderForm(normalizeWorkorderForForm(detail))
      setSignatureName(detail.customerSignatureName || detail.customerName || '')
      setLiveTimerMs(Number(detail.laborAccumulatedMs || 0))
    } catch {
      setBackendReachable(false)
      const bundle = buildLocalWorkorderBundle(loadLocalDb(), workorderId)
      if (!bundle) return
      setWorkorderParts(bundle.parts)
      setCustomerHistory(bundle.customerHistory)
      setEquipmentHistory(bundle.equipmentHistory)
      setWorkorderForm(normalizeWorkorderForForm(bundle.detail))
      setSignatureName(bundle.detail.customerSignatureName || bundle.detail.customerName || '')
      setLiveTimerMs(Number(bundle.detail.laborAccumulatedMs || 0))
    }
  }, [API, activeMode])

  useEffect(() => {
    Promise.resolve().then(loadAll).catch(() => {
      setStatus('Could not load workorders data.')
    })
  }, [loadAll])

  useEffect(() => {
    Promise.resolve().then(() => loadSelectedWorkorderData(selectedWorkorderId)).catch(() => {})
  }, [selectedWorkorderId, loadSelectedWorkorderData])

  const selectedWorkorder = useMemo(
    () => workorders.find((workorder) => String(workorder.id) === String(selectedWorkorderId)),
    [workorders, selectedWorkorderId]
  )

  const selectedMachine = useMemo(
    () => equipment.find((item) => String(item.id) === String(workorderForm.equipmentId || selectedWorkorder?.equipmentId || '')),
    [equipment, workorderForm.equipmentId, selectedWorkorder]
  )

  const selectedCustomer = useMemo(
    () => customers.find((customer) => String(customer.id) === String(workorderForm.customerId || selectedWorkorder?.customerId || selectedCustomerId || '')),
    [customers, workorderForm.customerId, selectedWorkorder, selectedCustomerId]
  )

  const filteredWorkorders = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return workorders
    return workorders.filter((workorder) => {
      const haystack = [
        workorder.number,
        workorder.title,
        workorder.status,
        workorder.customerName,
        workorder.equipmentName,
        workorder.complaint
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [searchText, workorders])

  const dashboardStats = useMemo(() => ({
    open: workorders.filter((item) => ['open', 'in progress', 'quote pending', 'waiting parts'].includes(item.status)).length,
    waitingParts: workorders.filter((item) => item.status === 'waiting parts').length,
    complete: workorders.filter((item) => item.status === 'complete').length,
    invoiced: workorders.filter((item) => item.status === 'invoiced').length
  }), [workorders])

  const activeTimerMs = useMemo(() => {
    if (!workorderForm.laborStartedAt) return Number(workorderForm.laborAccumulatedMs || 0)
    return Number(workorderForm.laborAccumulatedMs || 0) + liveTimerMs
  }, [liveTimerMs, workorderForm.laborAccumulatedMs, workorderForm.laborStartedAt])

  const invoiceTotals = useMemo(() => {
    const partsRetail = workorderParts.reduce((sum, item) => sum + Number(item.qtyUsed || 0) * Number(item.retailPrice || 0), 0)
    const timerHours = activeTimerMs / 3600000
    const laborHours = Math.max(Number(workorderForm.laborHours || 0), timerHours)
    const labor = laborHours * Number(workorderForm.laborRate || 0)
    return { partsRetail, laborHours, labor, total: partsRetail + labor }
  }, [activeTimerMs, workorderForm.laborHours, workorderForm.laborRate, workorderParts])

  useEffect(() => {
    if (!workorderForm.laborStartedAt) return undefined
    const startedAt = new Date(workorderForm.laborStartedAt).getTime()
    if (!Number.isFinite(startedAt)) return undefined
    const tick = () => setLiveTimerMs(Date.now() - startedAt)
    tick()
    const intervalId = window.setInterval(tick, 1000)
    return () => window.clearInterval(intervalId)
  }, [workorderForm.laborStartedAt])

  useEffect(() => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = '#061310'
    context.lineWidth = 2
    context.lineCap = 'round'
    if (!workorderForm.customerSignatureDataUrl) return
    const image = new Image()
    image.onload = () => {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    image.src = workorderForm.customerSignatureDataUrl
  }, [workorderForm.customerSignatureDataUrl, selectedWorkorderId])

  function applySpeechText(formName, field, text, setter) {
    if (!text) return
    if (formName === 'machine' && field === '__smart__') {
      const parsed = parseMachineSpeech(text)
      setter((current) => ({
        ...current,
        ...parsed,
        notes: [current.notes, text].filter(Boolean).join(current.notes ? '\n' : '')
      }))
      setStatus('Voice intake parsed into machine fields.')
      return
    }
    if (formName === 'workorder' && field === '__smart__') {
      const parsed = parseWorkorderSpeech(text)
      setter((current) => ({
        ...current,
        ...parsed,
        complaint: current.complaint || text,
        title: current.title || text.split(/[.!?]/)[0].slice(0, 80)
      }))
      setStatus('Voice intake parsed into workorder fields.')
      return
    }
    setter((current) => ({
      ...current,
      [field]: [current[field], text].filter(Boolean).join(current[field] ? ' ' : '')
    }))
    setStatus('Voice note added.')
  }

  async function login(event) {
    event.preventDefault()

    if (activeMode === 'local') {
      const user = loadLocalDb().users.find((item) => item.name === loginForm.name && item.pin === loginForm.pin)
      if (!user) {
        setStatus('Could not sign in.')
        return
      }
      const safeUser = { id: user.id, name: user.name, role: user.role }
      localStorage.setItem('workorders:currentUser', JSON.stringify(safeUser))
      setCurrentUser(safeUser)
      setStatus(`Signed in as ${safeUser.name} on this device.`)
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
    localStorage.setItem('workorders:currentUser', JSON.stringify(data.user))
    setCurrentUser(data.user)
    setStatus(`Signed in as ${data.user.name}.`)
  }

  function logout() {
    localStorage.removeItem('workorders:currentUser')
    setCurrentUser(null)
    setStatus('Signed out.')
  }

  function saveApiBase() {
    const cleaned = apiBase.replace(/\/$/, '')
    localStorage.setItem('workorders:apiBase', cleaned)
    setApiBase(cleaned)
    setStatus(`Server URL saved: ${cleaned}`)
  }

  function saveStorageMode(nextMode) {
    localStorage.setItem(LOCAL_MODE_KEY, nextMode)
    setStorageMode(nextMode)
    if (nextMode === 'local') {
      setBackendReachable(false)
      setStatus('Offline mode enabled. Using local device storage.')
    } else {
      setStatus('Auto mode enabled. The app will use the server when available.')
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
    setIsUnlocked(true)
    setUnlockPin('')
    setStatus('App passcode removed.')
  }

  function exportLocalBackup() {
    const payload = {
      version: 1,
      exportedAt: nowIso(),
      source: 'workorders-client-local',
      data: recalculateMeta(ensureLocalDbShape(loadLocalDb()))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `workorders-local-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setStatus('Local backup exported.')
  }

  function openImportPicker() {
    importFileRef.current?.click()
  }

  async function importLocalBackup(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const importedData = ensureLocalDbShape(parsed?.data || parsed)
      if (importMode === 'replace') {
        saveLocalDb(recalculateMeta(importedData))
        setStatus('Local backup restored with replace mode.')
      } else {
        const merged = withLocalDb((db) => mergeImportedDb(db, importedData))
        saveLocalDb(merged)
        setStatus('Local backup imported with merge mode.')
      }
      setSelectedWorkorderId('')
      setSelectedCustomerId('')
      await loadLocalAll()
    } catch {
      setStatus('Could not import that backup file.')
    } finally {
      event.target.value = ''
    }
  }

  async function uploadDataUrl(dataUrl, fileName) {
    if (activeMode === 'local') return dataUrl
    const res = await apiFetch(`${API}/uploads/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, fileName })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to upload image')
    return data.imageUrl
  }

  function uploadMachinePhoto(file, field) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const imageUrl = await uploadDataUrl(String(reader.result || ''), file.name)
        updateForm(setMachineForm, field, imageUrl)
        setStatus(field === 'serialPhotoUrl' ? 'Serial photo stored.' : 'Fleet photo stored.')
      } catch (err) {
        setStatus(err.message)
      }
    }
    reader.readAsDataURL(file)
  }

  async function captureSpeech(formName, field, setter) {
    try {
      const available = await SpeechRecognition.available()
      if (available.available) {
        const permission = await SpeechRecognition.requestPermissions()
        if (permission.speechRecognition !== 'granted') {
          setStatus('Microphone permission is required for dictation.')
          return
        }
        setDictatingField(`${formName}:${field}`)
        const result = await SpeechRecognition.start({
          language: 'en-US',
          maxResults: 1,
          prompt: 'Speak now',
          partialResults: false,
          popup: true
        })
        const text = result.matches?.[0]?.trim() || ''
        applySpeechText(formName, field, text, setter)
        setDictatingField('')
        return
      }
    } catch {
      // Fall through to browser speech.
    }

    const BrowserSpeech = getSpeechRecognition()
    if (!BrowserSpeech) {
      setStatus('Voice dictation is not available in this browser.')
      return
    }
    if (recognitionRef.current) recognitionRef.current.stop()
    const recognition = new BrowserSpeech()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onstart = () => setDictatingField(`${formName}:${field}`)
    recognition.onend = () => setDictatingField('')
    recognition.onerror = () => {
      setDictatingField('')
      setStatus('Voice dictation did not start. Check microphone permission.')
    }
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript?.trim() || ''
      applySpeechText(formName, field, text, setter)
    }
    recognitionRef.current = recognition
    recognition.start()
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
      setCustomerForm(emptyCustomer)
      setStatus('Customer saved on this device.')
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
    setCustomerForm(emptyCustomer)
    setStatus('Customer added.')
    loadAll()
  }

  async function addMachine() {
    if (!canWrite || !machineForm.name.trim()) return

    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.equipment.push({
          id: nextId(db.meta, 'nextEquipmentId'),
          ...machineForm,
          customerId: machineForm.customerId ? Number(machineForm.customerId) : null,
          createdAt: nowIso()
        })
      })
      setMachineForm({ ...emptyMachine, customerId: machineForm.customerId })
      setStatus('Machine saved on this device.')
      loadLocalAll()
      return
    }

    const res = await apiFetch(`${API}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...machineForm,
        customerId: machineForm.customerId ? Number(machineForm.customerId) : null
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add machine.')
      return
    }
    setMachineForm({ ...emptyMachine, customerId: machineForm.customerId })
    setStatus('Machine added.')
    loadAll()
  }

  async function addLocalPart() {
    if (!canWrite || !localPartForm.name.trim()) return
    withLocalDb((db) => {
      db.parts.push({
        id: nextId(db.meta, 'nextPartId'),
        name: localPartForm.name.trim(),
        partNumber: localPartForm.partNumber.trim(),
        quantity: Number(localPartForm.quantity) || 0,
        unit: 'each',
        unitCost: Number(localPartForm.unitCost) || 0,
        retailPrice: Number(localPartForm.retailPrice) || 0,
        createdAt: nowIso()
      })
    })
    setLocalPartForm(emptyLocalPart)
    setStatus('Local part added to this device.')
    loadLocalAll()
  }

  async function addWorkorder() {
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
          laborAccumulatedMs: Number(workorderForm.laborAccumulatedMs) || 0,
          createdAt: nowIso(),
          updatedAt: nowIso()
        }
        db.workorders.push(record)
        return record
      })
      setSelectedWorkorderId(String(created.id))
      setActiveTab('diagnose')
      setStatus(`Workorder ${created.number} saved on this device.`)
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
    setActiveTab('diagnose')
    setStatus(`Workorder ${data.number} added.`)
    loadAll()
  }

  async function saveWorkorder() {
    if (!selectedWorkorder) {
      setStatus('Select a workorder first.')
      return
    }

    if (activeMode === 'local') {
      withLocalDb((db) => {
        const row = db.workorders.find((item) => Number(item.id) === Number(selectedWorkorder.id))
        if (!row) return
        Object.assign(row, {
          ...workorderForm,
          customerId: workorderForm.customerId ? Number(workorderForm.customerId) : null,
          equipmentId: workorderForm.equipmentId ? Number(workorderForm.equipmentId) : null,
          laborHours: Number(workorderForm.laborHours) || 0,
          laborRate: Number(workorderForm.laborRate) || 0,
          laborAccumulatedMs: Number(workorderForm.laborAccumulatedMs) || 0,
          updatedAt: nowIso()
        })
      })
      setStatus(`Saved ${workorderForm.number || selectedWorkorder.number} on this device.`)
      await loadLocalAll()
      await loadSelectedWorkorderData(selectedWorkorder.id)
      return
    }

    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...workorderForm,
        customerId: workorderForm.customerId ? Number(workorderForm.customerId) : null,
        equipmentId: workorderForm.equipmentId ? Number(workorderForm.equipmentId) : null,
        laborHours: Number(workorderForm.laborHours) || 0,
        laborRate: Number(workorderForm.laborRate) || 0,
        laborAccumulatedMs: Number(workorderForm.laborAccumulatedMs) || 0
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to save workorder.')
      return
    }
    setStatus(`Saved ${workorderForm.number || selectedWorkorder.number}.`)
    await loadAll()
    await loadSelectedWorkorderData(selectedWorkorder.id)
  }

  async function addPartToWorkorder() {
    if (!selectedWorkorder || !partForm.partId) {
      setStatus('Select a workorder and part first.')
      return
    }

    if (activeMode === 'local') {
      const result = withLocalDb((db) => {
        const part = db.parts.find((item) => Number(item.id) === Number(partForm.partId))
        const workorder = db.workorders.find((item) => Number(item.id) === Number(selectedWorkorder.id))
        if (!part || !workorder) return { error: 'Part or workorder not found.' }
        const qty = Number(partForm.qty) || 1
        const qtyUsed = partForm.mode === 'use' ? Math.min(qty, Number(part.quantity || 0)) : 0
        const qtyReserved = partForm.mode === 'reserve' ? qty : qty
        part.quantity = Math.max(0, Number(part.quantity || 0) - qtyUsed)
        db.workorderParts.push({
          id: nextId(db.meta, 'nextWorkorderPartId'),
          workorderId: workorder.id,
          partId: part.id,
          qtyReserved,
          qtyUsed,
          unitCost: Number(part.unitCost || 0),
          retailPrice: Number(part.retailPrice || 0),
          note: partForm.note,
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
      setPartForm(emptyWorkorderPart)
      setStatus(partForm.mode === 'use' ? `Used ${result.actualUsed} part(s) on this device.` : 'Part reserved on this device.')
      await loadLocalAll()
      await loadSelectedWorkorderData(selectedWorkorder.id)
      return
    }

    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partId: Number(partForm.partId),
        qty: Number(partForm.qty) || 1,
        mode: partForm.mode,
        note: partForm.note
      })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to add part.')
      return
    }
    setPartForm(emptyWorkorderPart)
    setStatus(partForm.mode === 'use' ? `Used ${data.actualUsed} part(s).` : 'Part reserved.')
    await loadAll()
    await loadSelectedWorkorderData(selectedWorkorder.id)
  }

  async function removeReservedPart(partRow) {
    if (!partRow || Number(partRow.qtyUsed || 0) > 0) return

    if (activeMode === 'local') {
      withLocalDb((db) => {
        db.workorderParts = db.workorderParts.filter((item) => Number(item.id) !== Number(partRow.id))
      })
      setStatus('Reserved part removed from this device.')
      await loadLocalAll()
      await loadSelectedWorkorderData(selectedWorkorder.id)
      return
    }

    const res = await apiFetch(`${API}/workorder-parts/${partRow.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to remove reserved part.')
      return
    }
    setStatus('Reserved part removed.')
    await loadAll()
    await loadSelectedWorkorderData(selectedWorkorder.id)
  }

  async function returnUsedPart(partRow) {
    if (!partRow || Number(partRow.qtyUsed || 0) <= 0) return
    const qtyText = window.prompt(`Return how many from ${partRow.partName}?`, String(partRow.qtyUsed))
    const qty = Number(qtyText || 0)
    if (!qty) return
    const note = window.prompt('Return note (optional):', '') || ''

    if (activeMode === 'local') {
      const result = withLocalDb((db) => {
        const row = db.workorderParts.find((item) => Number(item.id) === Number(partRow.id))
        const part = db.parts.find((item) => Number(item.id) === Number(partRow.partId))
        if (!row || !part) return { error: 'Part record not found.' }
        if (Number(row.qtyUsed || 0) < qty) return { error: 'Cannot return more than was used.' }
        row.qtyUsed = Number(row.qtyUsed || 0) - qty
        row.qtyReserved = Math.max(0, Number(row.qtyReserved || 0) - qty)
        row.note = [row.note, note ? `Return: ${note}` : 'Returned to stock'].filter(Boolean).join('\n')
        row.updatedAt = nowIso()
        part.quantity = Number(part.quantity || 0) + qty
        return { qtyReturned: qty }
      })
      if (result.error) {
        setStatus(result.error)
        return
      }
      setStatus(`Returned ${result.qtyReturned} item(s) to local stock.`)
      await loadLocalAll()
      await loadSelectedWorkorderData(selectedWorkorder.id)
      return
    }

    const res = await apiFetch(`${API}/workorder-parts/${partRow.id}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty, note })
    })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to return part.')
      return
    }
    setStatus(`Returned ${data.qtyReturned} item(s) to stock.`)
    await loadAll()
    await loadSelectedWorkorderData(selectedWorkorder.id)
  }

  async function exportSelectedWorkorder(printAfterOpen = false) {
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
        .map((row) => ({
          ...row,
          partName: db.parts.find((part) => Number(part.id) === Number(row.partId))?.name || 'Unknown part',
          partNumber: db.parts.find((part) => Number(part.id) === Number(row.partId))?.partNumber || ''
        }))
      const html = buildWorkorderHtml(workorder, customer, machine, partRows)
      if (printAfterOpen) {
        const printWindow = window.open('', '_blank', 'noopener,noreferrer')
        if (!printWindow) {
          setStatus('Popup blocked. Allow popups to print/save PDF.')
          return
        }
        printWindow.document.write(html)
        printWindow.document.close()
        printWindow.focus()
        window.setTimeout(() => printWindow.print(), 400)
        setStatus('Local print view opened.')
        return
      }
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${selectedWorkorder.number || `WO-${selectedWorkorder.id}`}-workorder.html`.replace(/[^a-zA-Z0-9._-]/g, '-')
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

    if (printAfterOpen) {
      const html = await res.text()
      const printWindow = window.open('', '_blank', 'noopener,noreferrer')
      if (!printWindow) {
        setStatus('Popup blocked. Allow popups to print/save PDF.')
        return
      }
      printWindow.document.write(html)
      printWindow.document.close()
      printWindow.focus()
      window.setTimeout(() => printWindow.print(), 400)
      setStatus('Print view opened.')
      return
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${selectedWorkorder.number || `WO-${selectedWorkorder.id}`}-workorder.html`.replace(/[^a-zA-Z0-9._-]/g, '-')
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setStatus('Workorder export downloaded.')
  }

  async function startTimer() {
    if (!selectedWorkorder) return

    if (activeMode === 'local') {
      const startedAt = nowIso()
      withLocalDb((db) => {
        const row = db.workorders.find((item) => Number(item.id) === Number(selectedWorkorder.id))
        if (!row || row.laborStartedAt) return
        row.laborStartedAt = startedAt
        row.updatedAt = nowIso()
      })
      setWorkorderForm((current) => ({ ...current, laborStartedAt: startedAt }))
      setStatus('Local labor timer started.')
      return
    }

    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}/timer/start`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to start timer.')
      return
    }
    setWorkorderForm((current) => ({ ...current, laborStartedAt: data.laborStartedAt || current.laborStartedAt }))
    setStatus('Labor timer started.')
  }

  async function stopTimer() {
    if (!selectedWorkorder) return

    if (activeMode === 'local') {
      const elapsedMs = computeLaborMs(workorderForm)
      const laborHours = Math.max(Number(workorderForm.laborHours || 0), elapsedMs / 3600000)
      withLocalDb((db) => {
        const row = db.workorders.find((item) => Number(item.id) === Number(selectedWorkorder.id))
        if (!row) return
        row.laborStartedAt = ''
        row.laborAccumulatedMs = elapsedMs
        row.laborHours = laborHours
        row.updatedAt = nowIso()
      })
      setWorkorderForm((current) => ({
        ...current,
        laborStartedAt: '',
        laborAccumulatedMs: elapsedMs,
        laborHours
      }))
      setStatus('Local labor timer stopped.')
      await loadLocalAll()
      await loadSelectedWorkorderData(selectedWorkorder.id)
      return
    }

    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}/timer/stop`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      setStatus(data.error || 'Failed to stop timer.')
      return
    }
    setWorkorderForm((current) => ({
      ...current,
      laborStartedAt: '',
      laborAccumulatedMs: Number(data.laborAccumulatedMs || 0),
      laborHours: Number(data.laborHours || current.laborHours || 0)
    }))
    setStatus('Labor timer stopped.')
    await loadAll()
    await loadSelectedWorkorderData(selectedWorkorder.id)
  }

  function getCanvasPoint(event) {
    const canvas = signatureCanvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    }
  }

  function beginSignature(event) {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    const point = getCanvasPoint(event)
    drawingRef.current = true
    context.beginPath()
    context.moveTo(point.x, point.y)
  }

  function drawSignature(event) {
    if (!drawingRef.current) return
    const canvas = signatureCanvasRef.current
    const context = canvas.getContext('2d')
    const point = getCanvasPoint(event)
    context.lineTo(point.x, point.y)
    context.stroke()
    setIsSignatureDirty(true)
  }

  function endSignature() {
    drawingRef.current = false
  }

  function clearSignature() {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    setIsSignatureDirty(true)
    setWorkorderForm((current) => ({
      ...current,
      customerSignatureDataUrl: '',
      customerSignatureName: '',
      customerSignedAt: ''
    }))
  }

  function saveSignatureToForm() {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    setWorkorderForm((current) => ({
      ...current,
      customerSignatureDataUrl: canvas.toDataURL('image/png'),
      customerSignatureName: signatureName.trim(),
      customerSignedAt: nowIso()
    }))
    setIsSignatureDirty(false)
    setStatus('Signature captured. Save workorder to keep it.')
  }

  async function copyStatusUpdate() {
    if (!selectedWorkorder) return
    const lines = [
      `${selectedWorkorder.number}: ${workorderForm.status || selectedWorkorder.status}`,
      selectedCustomer?.name ? `Customer: ${selectedCustomer.name}` : '',
      selectedMachine?.name ? `Machine: ${selectedMachine.name}` : '',
      workorderForm.diagnosis ? `Diagnosis: ${workorderForm.diagnosis}` : '',
      workorderForm.laborNotes ? `Work done: ${workorderForm.laborNotes}` : ''
    ].filter(Boolean)
    await navigator.clipboard.writeText(lines.join('\n'))
    setStatus('Status update copied to clipboard.')
  }

  return (
    <main className="workorders-shell">
      <input
        ref={importFileRef}
        type="file"
        accept="application/json"
        onChange={importLocalBackup}
        style={{ display: 'none' }}
      />
      {appPasscode && !isUnlocked && (
        <div className="lock-overlay">
          <form className="lock-panel" onSubmit={unlockApp}>
            <h2>App Locked</h2>
            <p>Enter the device passcode to open Workorders.</p>
            <label>
              App Passcode
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
          <p className="eyebrow">Workorders</p>
          <h1>Intake, diagnosis, invoice, and customer history in one lane.</h1>
        </div>
        <div className="stats-grid">
          <div><strong>{dashboardStats.open}</strong><span>Active Jobs</span></div>
          <div><strong>{dashboardStats.waitingParts}</strong><span>Waiting Parts</span></div>
          <div><strong>{dashboardStats.complete}</strong><span>Completed</span></div>
          <div><strong>{customers.length}</strong><span>Customers</span></div>
        </div>
      </header>

      {status && <div className="status-bar">{status}</div>}

      <section className="top-actions">
        <form className="panel" onSubmit={login}>
          <h2>Session</h2>
          {currentUser ? (
            <>
              <p>{currentUser.name} ({currentUser.role})</p>
              <p>{activeMode === 'local' ? 'Using local device storage.' : 'Connected to server.'}</p>
              <button type="button" onClick={logout}>Sign Out</button>
            </>
          ) : (
            <>
              <label>
                User
                <select value={loginForm.name} onChange={(e) => updateForm(setLoginForm, 'name', e.target.value)}>
                  {users.map((user) => <option key={user.id} value={user.name}>{user.name}</option>)}
                </select>
              </label>
              <label>
                PIN
                <input type="password" inputMode="numeric" value={loginForm.pin} onChange={(e) => updateForm(setLoginForm, 'pin', e.target.value)} />
              </label>
              <button className="primary-action" type="submit">Sign In</button>
            </>
          )}
        </form>

        <div className="panel">
          <h2>Storage</h2>
          <label>
            Mode
            <select value={storageMode} onChange={(e) => saveStorageMode(e.target.value)}>
              <option value="auto">Auto (Server if available)</option>
              <option value="local">Offline / Local device only</option>
            </select>
          </label>
          <label>
            Backend URL
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://192.168.1.158:3001" />
          </label>
          <button onClick={saveApiBase}>Save Server URL</button>
          <p>{activeMode === 'local' ? 'This device is running standalone right now.' : 'This device is using the shared server right now.'}</p>
          <div className="local-subpanel">
            <h2>Backup & Restore</h2>
            <label>
              Import Mode
              <select value={importMode} onChange={(e) => setImportMode(e.target.value)}>
                <option value="merge">Merge Into Local Data</option>
                <option value="replace">Replace Local Data</option>
              </select>
            </label>
            <div className="inline-actions">
              <button type="button" onClick={exportLocalBackup}>Export Local Backup</button>
              <button type="button" onClick={openImportPicker}>Import Backup</button>
            </div>
          </div>
          <div className="local-subpanel">
            <h2>App Lock</h2>
            <div className="field-grid">
              <label>
                New Passcode
                <input
                  type="password"
                  inputMode="numeric"
                  value={passcodeForm.passcode}
                  onChange={(e) => updateForm(setPasscodeForm, 'passcode', e.target.value)}
                  placeholder="4 to 8 digits"
                />
              </label>
              <label>
                Confirm Passcode
                <input
                  type="password"
                  inputMode="numeric"
                  value={passcodeForm.confirmPasscode}
                  onChange={(e) => updateForm(setPasscodeForm, 'confirmPasscode', e.target.value)}
                />
              </label>
            </div>
            <div className="inline-actions">
              <button type="button" className="primary-action" onClick={saveAppPasscode}>Save App Passcode</button>
              <button type="button" onClick={lockAppNow}>Lock Now</button>
              <button type="button" onClick={clearAppPasscode}>Remove Passcode</button>
            </div>
          </div>
        </div>
      </section>

      <div className="tab-row">
        <button className={activeTab === 'dashboard' ? 'active-tab' : ''} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
        <button className={activeTab === 'intake' ? 'active-tab' : ''} onClick={() => setActiveTab('intake')}>Drop-Off Intake</button>
        <button className={activeTab === 'diagnose' ? 'active-tab' : ''} onClick={() => setActiveTab('diagnose')}>Diagnose & Quote</button>
        <button className={activeTab === 'invoice' ? 'active-tab' : ''} onClick={() => setActiveTab('invoice')}>Work Done & Invoice</button>
        <button className={activeTab === 'history' ? 'active-tab' : ''} onClick={() => setActiveTab('history')}>History</button>
      </div>

      <section className="work-grid">
        <div className="panel">
          <h2>Workorders</h2>
          <label>
            Search
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="WO, customer, machine, complaint" />
          </label>
          <div className="picker-list">
            {filteredWorkorders.map((workorder) => (
              <button
                key={workorder.id}
                className={String(selectedWorkorderId) === String(workorder.id) ? 'selected-item' : ''}
                onClick={() => setSelectedWorkorderId(String(workorder.id))}
              >
                <span>{workorder.number} - {workorder.title}</span>
                <small>{workorder.customerName || 'No customer'} | {workorder.status}</small>
              </button>
            ))}
            {filteredWorkorders.length === 0 && <div className="empty-state">No matching workorders.</div>}
          </div>
        </div>

        {activeTab === 'dashboard' && (
          <div className="dashboard-grid">
            <div className="panel">
              <h2>Today at a Glance</h2>
              <div className="summary-list">
                <div><span>Total workorders</span><strong>{workorders.length}</strong></div>
                <div><span>Machines on file</span><strong>{equipment.length}</strong></div>
                <div><span>Parts available</span><strong>{parts.length}</strong></div>
                <div><span>Selected workorder parts</span><strong>{workorderParts.length}</strong></div>
              </div>
            </div>
            <div className="panel">
              <h2>Recent Jobs</h2>
              <div className="parts-list">
                {workorders.slice(0, 8).map((item) => (
                  <div key={item.id}>
                    <span><strong>{item.number}</strong> {item.title}</span>
                    <span>{item.status}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel wide-panel">
              <h2>Quick Status Message</h2>
              {selectedWorkorder ? (
                <>
                  <div className="summary-list">
                    <div><span>Workorder</span><strong>{selectedWorkorder.number}</strong></div>
                    <div><span>Customer</span><strong>{selectedCustomer?.name || 'None'}</strong></div>
                    <div><span>Machine</span><strong>{selectedMachine?.name || selectedWorkorder.equipmentName || 'None'}</strong></div>
                    <div><span>Status</span><strong>{workorderForm.status || selectedWorkorder.status}</strong></div>
                  </div>
                  <button onClick={copyStatusUpdate}>Copy Status Update</button>
                </>
              ) : (
                <div className="empty-state">Select a workorder to prep a message.</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'intake' && (
          <div className="contact-grid">
            <div className="panel">
              <h2>Customer Contacts</h2>
              <div className="picker-list">
                {customers.map((customer) => (
                  <button
                    key={customer.id}
                    className={String(selectedCustomerId) === String(customer.id) ? 'selected-item' : ''}
                    onClick={() => {
                      setSelectedCustomerId(String(customer.id))
                      updateForm(setMachineForm, 'customerId', String(customer.id))
                      updateForm(setWorkorderForm, 'customerId', String(customer.id))
                      setSignatureName(customer.name)
                    }}
                  >
                    <span>{customer.name}</span>
                    <small>{customer.phone || customer.email || 'No contact details'}</small>
                  </button>
                ))}
              </div>
              <div className="field-grid">
                <label>
                  Name
                  <input value={customerForm.name} onChange={(e) => updateForm(setCustomerForm, 'name', e.target.value)} />
                </label>
                <label>
                  Phone
                  <input value={customerForm.phone} onChange={(e) => updateForm(setCustomerForm, 'phone', e.target.value)} />
                </label>
                <label>
                  Email
                  <input value={customerForm.email} onChange={(e) => updateForm(setCustomerForm, 'email', e.target.value)} />
                </label>
                <label className="full-span">
                  Notes
                  <textarea value={customerForm.notes} onChange={(e) => updateForm(setCustomerForm, 'notes', e.target.value)} />
                </label>
              </div>
              <button className="primary-action" onClick={addCustomer} disabled={!canWrite}>Add Customer</button>
            </div>

            <div className="panel wide-panel">
              <h2>Machine Intake</h2>
              <div className="inline-actions">
                <button type="button" className="dictate-button" onClick={() => captureSpeech('machine', '__smart__', setMachineForm)}>
                  {dictatingField === 'machine:__smart__' ? 'Listening...' : 'Smart Intake Voice'}
                </button>
              </div>
              <div className="field-grid">
                <label>
                  Customer
                  <select value={machineForm.customerId} onChange={(e) => updateForm(setMachineForm, 'customerId', e.target.value)}>
                    <option value="">No Customer</option>
                    {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                  </select>
                </label>
                <label>
                  Fleet / Unit Number
                  <div className="voice-grid">
                    <input value={machineForm.unitNumber} onChange={(e) => updateForm(setMachineForm, 'unitNumber', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('machine', 'unitNumber', setMachineForm)} type="button">
                      {dictatingField === 'machine:unitNumber' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  Machine Name
                  <input value={machineForm.name} onChange={(e) => updateForm(setMachineForm, 'name', e.target.value)} />
                </label>
                <label>
                  Brand / Make
                  <div className="voice-grid">
                    <input value={machineForm.make} onChange={(e) => updateForm(setMachineForm, 'make', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('machine', 'make', setMachineForm)} type="button">
                      {dictatingField === 'machine:make' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  Model
                  <div className="voice-grid">
                    <input value={machineForm.model} onChange={(e) => updateForm(setMachineForm, 'model', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('machine', 'model', setMachineForm)} type="button">
                      {dictatingField === 'machine:model' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  Serial Number
                  <div className="voice-grid">
                    <input value={machineForm.serial} onChange={(e) => updateForm(setMachineForm, 'serial', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('machine', 'serial', setMachineForm)} type="button">
                      {dictatingField === 'machine:serial' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  VIN
                  <input value={machineForm.vin} onChange={(e) => updateForm(setMachineForm, 'vin', e.target.value)} />
                </label>
                <label>
                  Year
                  <input value={machineForm.year} onChange={(e) => updateForm(setMachineForm, 'year', e.target.value)} />
                </label>
                <label>
                  Hours
                  <input value={machineForm.hours} onChange={(e) => updateForm(setMachineForm, 'hours', e.target.value)} />
                </label>
                <label>
                  Mileage
                  <input value={machineForm.mileage} onChange={(e) => updateForm(setMachineForm, 'mileage', e.target.value)} />
                </label>
                <label>
                  Serial Photo
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => uploadMachinePhoto(e.target.files[0], 'serialPhotoUrl')} />
                </label>
                <label>
                  Fleet Photo
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => uploadMachinePhoto(e.target.files[0], 'fleetPhotoUrl')} />
                </label>
                <label className="full-span">
                  Intake Notes
                  <div className="voice-grid">
                    <textarea value={machineForm.notes} onChange={(e) => updateForm(setMachineForm, 'notes', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('machine', 'notes', setMachineForm)} type="button">
                      {dictatingField === 'machine:notes' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
              </div>
              {(machineForm.serialPhotoUrl || machineForm.fleetPhotoUrl) && (
                <div className="machine-photo-row">
                  {machineForm.serialPhotoUrl && <img src={assetUrl(machineForm.serialPhotoUrl)} alt="" />}
                  {machineForm.fleetPhotoUrl && <img src={assetUrl(machineForm.fleetPhotoUrl)} alt="" />}
                </div>
              )}
              <button className="primary-action" onClick={addMachine} disabled={!canWrite}>Add Machine</button>
            </div>

            <div className="panel wide-panel">
              <h2>Create Workorder</h2>
              <div className="inline-actions">
                <button type="button" className="dictate-button" onClick={() => captureSpeech('workorder', '__smart__', setWorkorderForm)}>
                  {dictatingField === 'workorder:__smart__' ? 'Listening...' : 'Smart Workorder Voice'}
                </button>
              </div>
              <div className="field-grid">
                <label>
                  Number
                  <input value={workorderForm.number} onChange={(e) => updateForm(setWorkorderForm, 'number', e.target.value)} placeholder="Auto if blank" />
                </label>
                <label>
                  Title
                  <input value={workorderForm.title} onChange={(e) => updateForm(setWorkorderForm, 'title', e.target.value)} />
                </label>
                <label>
                  Customer
                  <select value={workorderForm.customerId} onChange={(e) => updateForm(setWorkorderForm, 'customerId', e.target.value)}>
                    <option value="">No Customer</option>
                    {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                  </select>
                </label>
                <label>
                  Machine
                  <select value={workorderForm.equipmentId} onChange={(e) => updateForm(setWorkorderForm, 'equipmentId', e.target.value)}>
                    <option value="">No Machine</option>
                    {equipment
                      .filter((item) => !workorderForm.customerId || String(item.customerId) === String(workorderForm.customerId))
                      .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="full-span">
                  Customer Complaint
                  <div className="voice-grid">
                    <textarea value={workorderForm.complaint} onChange={(e) => updateForm(setWorkorderForm, 'complaint', e.target.value)} />
                    <button className="dictate-button" onClick={() => captureSpeech('workorder', 'complaint', setWorkorderForm)} type="button">
                      {dictatingField === 'workorder:complaint' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
              </div>
              <button className="primary-action" onClick={addWorkorder} disabled={!canWrite}>Add Workorder</button>
            </div>
          </div>
        )}

        {activeTab === 'diagnose' && (
          <div className="detail-grid">
            <div className="panel wide-panel">
              <h2>Diagnosis & Quote</h2>
              {selectedWorkorder ? (
                <>
                  <div className="field-grid">
                    <label>
                      Number
                      <input value={workorderForm.number} onChange={(e) => updateForm(setWorkorderForm, 'number', e.target.value)} />
                    </label>
                    <label>
                      Title
                      <input value={workorderForm.title} onChange={(e) => updateForm(setWorkorderForm, 'title', e.target.value)} />
                    </label>
                    <label>
                      Status
                      <select value={workorderForm.status} onChange={(e) => updateForm(setWorkorderForm, 'status', e.target.value)}>
                        {statusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </label>
                    <label>
                      Labor Rate
                      <input type="number" min="0" step="0.01" value={workorderForm.laborRate} onChange={(e) => updateForm(setWorkorderForm, 'laborRate', e.target.value)} />
                    </label>
                    <label>
                      Manual Labor Hours
                      <input type="number" min="0" step="0.1" value={workorderForm.laborHours} onChange={(e) => updateForm(setWorkorderForm, 'laborHours', e.target.value)} />
                    </label>
                    <label>
                      Timer
                      <div className="timer-row">
                        <strong>{formatDuration(activeTimerMs)}</strong>
                        <button type="button" onClick={workorderForm.laborStartedAt ? stopTimer : startTimer}>
                          {workorderForm.laborStartedAt ? 'Stop Timer' : 'Start Timer'}
                        </button>
                      </div>
                    </label>
                    <label className="full-span">
                      Diagnosis
                      <div className="voice-grid">
                        <textarea value={workorderForm.diagnosis} onChange={(e) => updateForm(setWorkorderForm, 'diagnosis', e.target.value)} />
                        <button className="dictate-button" onClick={() => captureSpeech('workorder', 'diagnosis', setWorkorderForm)} type="button">
                          {dictatingField === 'workorder:diagnosis' ? 'Listening...' : 'Voice'}
                        </button>
                      </div>
                    </label>
                  </div>
                  <div className="inline-actions">
                    <button className="primary-action" onClick={saveWorkorder}>Save Workorder</button>
                  </div>
                </>
              ) : (
                <div className="empty-state">Select a workorder first.</div>
              )}
            </div>

            <div className="panel wide-panel">
              <h2>Parts / Quote</h2>
              {selectedWorkorder ? (
                <>
                  <div className="field-grid">
                    <label>
                      Part
                      <select value={partForm.partId} onChange={(e) => updateForm(setPartForm, 'partId', e.target.value)}>
                        <option value="">Choose Part</option>
                        {parts.map((part) => (
                          <option key={part.id} value={part.id}>
                            {part.name} - on hand {part.quantity} / available {part.availableQty ?? part.quantity}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Qty
                      <input type="number" min="1" value={partForm.qty} onChange={(e) => updateForm(setPartForm, 'qty', e.target.value)} />
                    </label>
                    <label>
                      Action
                      <select value={partForm.mode} onChange={(e) => updateForm(setPartForm, 'mode', e.target.value)}>
                        <option value="reserve">Reserve</option>
                        <option value="use">Use Now</option>
                      </select>
                    </label>
                    <label className="full-span">
                      Note
                      <div className="voice-grid">
                        <textarea value={partForm.note} onChange={(e) => updateForm(setPartForm, 'note', e.target.value)} />
                        <button className="dictate-button" onClick={() => captureSpeech('part', 'note', setPartForm)} type="button">
                          {dictatingField === 'part:note' ? 'Listening...' : 'Voice'}
                        </button>
                      </div>
                    </label>
                  </div>
                  <button className="primary-action" onClick={addPartToWorkorder}>Add Part</button>

                  {activeMode === 'local' && (
                    <div className="local-subpanel">
                      <h2>Local Parts Catalog</h2>
                      <div className="field-grid">
                        <label>
                          Part Name
                          <input value={localPartForm.name} onChange={(e) => updateForm(setLocalPartForm, 'name', e.target.value)} />
                        </label>
                        <label>
                          Part Number
                          <input value={localPartForm.partNumber} onChange={(e) => updateForm(setLocalPartForm, 'partNumber', e.target.value)} />
                        </label>
                        <label>
                          Quantity
                          <input type="number" min="0" value={localPartForm.quantity} onChange={(e) => updateForm(setLocalPartForm, 'quantity', e.target.value)} />
                        </label>
                        <label>
                          Unit Cost
                          <input type="number" min="0" step="0.01" value={localPartForm.unitCost} onChange={(e) => updateForm(setLocalPartForm, 'unitCost', e.target.value)} />
                        </label>
                        <label>
                          Retail Price
                          <input type="number" min="0" step="0.01" value={localPartForm.retailPrice} onChange={(e) => updateForm(setLocalPartForm, 'retailPrice', e.target.value)} />
                        </label>
                      </div>
                      <button className="primary-action" onClick={addLocalPart}>Add Local Part</button>
                    </div>
                  )}

                  <div className="parts-list">
                    {workorderParts.map((item) => (
                      <div key={item.id} className="stacked-row">
                        <div>
                          <strong>{item.partName || 'Unknown part'}</strong>
                          <small>Reserved {item.qtyReserved} | Used {item.qtyUsed} | {formatCurrency(item.retailPrice)} retail</small>
                        </div>
                        <div className="inline-actions">
                          {Number(item.qtyUsed || 0) > 0 && <button type="button" onClick={() => returnUsedPart(item)}>Return</button>}
                          {Number(item.qtyUsed || 0) === 0 && <button type="button" onClick={() => removeReservedPart(item)}>Remove</button>}
                        </div>
                      </div>
                    ))}
                    {workorderParts.length === 0 && <div className="empty-state">No parts on this workorder yet.</div>}
                  </div>
                </>
              ) : (
                <div className="empty-state">Select a workorder first.</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'invoice' && (
          <div className="invoice-grid">
            <div className="panel">
              <h2>Selected Workorder</h2>
              {selectedWorkorder ? (
                <div className="summary-list">
                  <div><span>Number</span><strong>{selectedWorkorder.number}</strong></div>
                  <div><span>Customer</span><strong>{selectedCustomer?.name || selectedWorkorder.customerName || 'None'}</strong></div>
                  <div><span>Machine</span><strong>{selectedMachine?.name || selectedWorkorder.equipmentName || 'None'}</strong></div>
                  <div><span>Status</span><strong>{workorderForm.status || selectedWorkorder.status}</strong></div>
                  {selectedMachine && <div><span>Brand / Model</span><strong>{[selectedMachine.make, selectedMachine.model].filter(Boolean).join(' ') || 'None'}</strong></div>}
                </div>
              ) : (
                <div className="empty-state">Select a workorder first.</div>
              )}
            </div>

            <div className="panel">
              <h2>Work Done / Invoice</h2>
              {selectedWorkorder ? (
                <>
                  <label>
                    Work Done Notes
                    <div className="voice-grid">
                      <textarea value={workorderForm.laborNotes} onChange={(e) => updateForm(setWorkorderForm, 'laborNotes', e.target.value)} />
                      <button className="dictate-button" onClick={() => captureSpeech('workorder', 'laborNotes', setWorkorderForm)} type="button">
                        {dictatingField === 'workorder:laborNotes' ? 'Listening...' : 'Voice'}
                      </button>
                    </div>
                  </label>
                  <div className="parts-list">
                    {workorderParts.map((item) => (
                      <div key={item.id}>
                        <span><strong>{item.partName}</strong> x {item.qtyUsed || item.qtyReserved}</span>
                        <span>{formatCurrency(Number(item.qtyUsed || 0) * Number(item.retailPrice || 0))}</span>
                      </div>
                    ))}
                    {workorderParts.length === 0 && <div className="empty-state">No parts on this workorder yet.</div>}
                  </div>
                  <div className="summary-list">
                    <div><span>Parts</span><strong>{formatCurrency(invoiceTotals.partsRetail)}</strong></div>
                    <div><span>Labor ({invoiceTotals.laborHours.toFixed(2)} hrs)</span><strong>{formatCurrency(invoiceTotals.labor)}</strong></div>
                  </div>
                  <div className="invoice-total">
                    <span>Total</span>
                    <strong>{formatCurrency(invoiceTotals.total)}</strong>
                  </div>
                  <div className="signature-block">
                    <label>
                      Signature Name
                      <input value={signatureName} onChange={(e) => setSignatureName(e.target.value)} placeholder="Customer name" />
                    </label>
                    <canvas
                      ref={signatureCanvasRef}
                      className="signature-canvas"
                      width="500"
                      height="180"
                      onPointerDown={beginSignature}
                      onPointerMove={drawSignature}
                      onPointerUp={endSignature}
                      onPointerLeave={endSignature}
                    />
                    <div className="inline-actions">
                      <button type="button" onClick={clearSignature}>Clear Signature</button>
                      <button type="button" onClick={saveSignatureToForm}>Use Signature</button>
                    </div>
                    {workorderForm.customerSignedAt && !isSignatureDirty && (
                      <p>Captured {new Date(workorderForm.customerSignedAt).toLocaleString()}</p>
                    )}
                  </div>
                  <div className="inline-actions">
                    <button className="primary-action" onClick={saveWorkorder}>Save Workorder</button>
                    <button onClick={() => exportSelectedWorkorder(false)}>Export for Email</button>
                    <button onClick={() => exportSelectedWorkorder(true)}>Open PDF Print View</button>
                  </div>
                </>
              ) : (
                <div className="empty-state">Select a workorder first.</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="detail-grid">
            <div className="panel">
              <h2>Customer History</h2>
              {selectedCustomer ? (
                <>
                  <p>{selectedCustomer.name} {selectedCustomer.phone ? `| ${selectedCustomer.phone}` : ''}</p>
                  <div className="parts-list">
                    {customerHistory.map((item) => (
                      <div key={item.id}>
                        <span><strong>{item.number}</strong> {item.title}</span>
                        <span>{item.status}</span>
                      </div>
                    ))}
                    {customerHistory.length === 0 && <div className="empty-state">No earlier workorders for this customer.</div>}
                  </div>
                </>
              ) : (
                <div className="empty-state">Pick or select a customer first.</div>
              )}
            </div>
            <div className="panel">
              <h2>Machine History</h2>
              {selectedMachine ? (
                <>
                  <p>{selectedMachine.name} {[selectedMachine.make, selectedMachine.model].filter(Boolean).join(' ')}</p>
                  {(selectedMachine.serialPhotoUrl || selectedMachine.fleetPhotoUrl) && (
                    <div className="machine-photo-row">
                      {selectedMachine.serialPhotoUrl && <img src={assetUrl(selectedMachine.serialPhotoUrl)} alt="" />}
                      {selectedMachine.fleetPhotoUrl && <img src={assetUrl(selectedMachine.fleetPhotoUrl)} alt="" />}
                    </div>
                  )}
                  <div className="parts-list">
                    {equipmentHistory.map((item) => (
                      <div key={item.id}>
                        <span><strong>{item.number}</strong> {item.title}</span>
                        <span>{item.status}</span>
                      </div>
                    ))}
                    {equipmentHistory.length === 0 && <div className="empty-state">No earlier workorders for this machine.</div>}
                  </div>
                </>
              ) : (
                <div className="empty-state">Select a workorder with a machine to see its history.</div>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
