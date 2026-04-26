import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'

const host = window.location.hostname || 'localhost'
const defaultApiBase = `http://${host}:3001`

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

export default function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('workorders:apiBase') || defaultApiBase)
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
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('workorders:currentUser')
    return saved ? JSON.parse(saved) : null
  })
  const [loginForm, setLoginForm] = useState(emptyLogin)
  const [customerForm, setCustomerForm] = useState(emptyCustomer)
  const [machineForm, setMachineForm] = useState(emptyMachine)
  const [workorderForm, setWorkorderForm] = useState(emptyWorkorder)
  const [partForm, setPartForm] = useState(emptyWorkorderPart)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [selectedWorkorderId, setSelectedWorkorderId] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [dictatingField, setDictatingField] = useState('')
  const [isSignatureDirty, setIsSignatureDirty] = useState(false)
  const [liveTimerMs, setLiveTimerMs] = useState(0)
  const recognitionRef = useRef(null)
  const signatureCanvasRef = useRef(null)
  const drawingRef = useRef(false)
  const API = `${apiBase.replace(/\/$/, '')}/api`
  const ASSET_BASE = apiBase.replace(/\/$/, '')
  const canWrite = currentUser && ['owner', 'tech'].includes(currentUser.role)

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
    const [usersRes, customersRes, equipmentRes, partsRes, workordersRes] = await Promise.all([
      fetch(`${API}/users`),
      fetch(`${API}/customers`),
      fetch(`${API}/equipment`),
      fetch(`${API}/parts`),
      fetch(`${API}/workorders`)
    ])

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

    if (!selectedCustomerId && nextCustomers[0]) setSelectedCustomerId(String(nextCustomers[0].id))
    if (!selectedWorkorderId && nextWorkorders[0]) setSelectedWorkorderId(String(nextWorkorders[0].id))
  }, [API, selectedCustomerId, selectedWorkorderId])

  const loadSelectedWorkorderData = useCallback(async (workorderId) => {
    if (!workorderId) {
      setWorkorderParts([])
      setCustomerHistory([])
      setEquipmentHistory([])
      return
    }

    const detailRes = await fetch(`${API}/workorders/${workorderId}`)
    if (!detailRes.ok) return
    const detail = await detailRes.json()

    const requests = [
      fetch(`${API}/workorders/${workorderId}/parts`)
    ]
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
  }, [API])

  useEffect(() => {
    Promise.resolve().then(loadAll).catch(() => {
      setStatus('Could not reach the backend. Make sure the server is running.')
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

  function updateForm(setter, field, value) {
    setter((current) => ({ ...current, [field]: value }))
  }

  function assetUrl(src) {
    if (!src) return ''
    return src.startsWith('/uploads/') ? `${ASSET_BASE}${src}` : src
  }

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

  async function uploadDataUrl(dataUrl, fileName) {
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
        setStatus(field === 'serialPhotoUrl' ? 'Serial photo uploaded.' : 'Fleet photo uploaded.')
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
      // Browser fallback below.
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

  async function addWorkorder() {
    if (!canWrite || !workorderForm.title.trim()) return
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
      customerSignedAt: new Date().toISOString()
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
          <h2>Server</h2>
          <label>
            Backend URL
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://192.168.1.158:3001" />
          </label>
          <button onClick={saveApiBase}>Save Server URL</button>
          <p>Android uses the app shell. Windows can install this as a browser app.</p>
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
                <div><span>Inventory parts linked</span><strong>{parts.length}</strong></div>
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
                    <button onClick={() => exportSelectedWorkorder(true)}>Print / Save PDF</button>
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
