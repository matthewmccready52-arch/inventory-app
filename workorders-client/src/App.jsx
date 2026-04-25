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
  laborRate: 0
}
const emptyWorkorderPart = { partId: '', qty: 1, mode: 'reserve', note: '' }

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
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
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('workorders:currentUser')
    return saved ? JSON.parse(saved) : null
  })
  const [loginForm, setLoginForm] = useState(emptyLogin)
  const [customerForm, setCustomerForm] = useState(emptyCustomer)
  const [machineForm, setMachineForm] = useState(emptyMachine)
  const [workorderForm, setWorkorderForm] = useState(emptyWorkorder)
  const [partForm, setPartForm] = useState(emptyWorkorderPart)
  const [activeTab, setActiveTab] = useState('intake')
  const [selectedWorkorderId, setSelectedWorkorderId] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const recognitionRef = useRef(null)
  const [dictatingField, setDictatingField] = useState('')
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
    const activeWorkorderId = selectedWorkorderId || nextWorkorders[0]?.id || ''

    setUsers(nextUsers)
    setCustomers(nextCustomers)
    setEquipment(nextEquipment)
    setParts(nextParts)
    setWorkorders(nextWorkorders)

    if (!selectedCustomerId && nextCustomers[0]) setSelectedCustomerId(String(nextCustomers[0].id))
    if (!selectedWorkorderId && activeWorkorderId) setSelectedWorkorderId(String(activeWorkorderId))

    if (activeWorkorderId) {
      const partsForWorkorderRes = await fetch(`${API}/workorders/${activeWorkorderId}/parts`)
      setWorkorderParts(await partsForWorkorderRes.json())
    } else {
      setWorkorderParts([])
    }
  }, [API, selectedCustomerId, selectedWorkorderId])

  useEffect(() => {
    Promise.resolve().then(loadAll).catch(() => {
      setStatus('Could not reach the backend. Make sure the server is running.')
    })
  }, [loadAll])

  const selectedWorkorder = useMemo(
    () => workorders.find((workorder) => String(workorder.id) === String(selectedWorkorderId)),
    [workorders, selectedWorkorderId]
  )

  const customerOptions = useMemo(
    () => customers.map((customer) => ({ ...customer, selected: String(customer.id) === String(selectedCustomerId) })),
    [customers, selectedCustomerId]
  )

  const selectedMachine = useMemo(
    () => equipment.find((item) => String(item.id) === String(workorderForm.equipmentId || selectedWorkorder?.equipmentId || '')),
    [equipment, workorderForm.equipmentId, selectedWorkorder]
  )

  const invoiceTotals = useMemo(() => {
    const partsRetail = workorderParts.reduce((sum, item) => sum + Number(item.qtyUsed || 0) * Number(item.retailPrice || 0), 0)
    const labor = Number(selectedWorkorder?.laborHours || 0) * Number(selectedWorkorder?.laborRate || 0)
    return { partsRetail, labor, total: partsRetail + labor }
  }, [selectedWorkorder, workorderParts])

  function updateForm(setter, field, value) {
    setter((current) => ({ ...current, [field]: value }))
  }

  function assetUrl(src) {
    if (!src) return ''
    return src.startsWith('/uploads/') ? `${ASSET_BASE}${src}` : src
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

  async function startDictation(formName, field, setter) {
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
        if (text) {
          setter((current) => ({
            ...current,
            [field]: [current[field], text].filter(Boolean).join(current[field] ? ' ' : '')
          }))
          setStatus('Voice note added.')
        }
        setDictatingField('')
        return
      }
    } catch {
      // Fall back to web speech recognition below.
    }

    const SpeechRecognition = getSpeechRecognition()
    if (!SpeechRecognition) {
      setStatus('Voice dictation is not available in this browser.')
      return
    }

    if (recognitionRef.current) recognitionRef.current.stop()

    const recognition = new SpeechRecognition()
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
      if (!text) return
      setter((current) => ({
        ...current,
        [field]: [current[field], text].filter(Boolean).join(current[field] ? ' ' : '')
      }))
      setStatus('Voice note added.')
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
    setWorkorderForm((current) => ({ ...current, number: '', title: '', complaint: '', diagnosis: '', laborNotes: '' }))
    setStatus(`Workorder ${data.number} added.`)
    loadAll()
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
    loadAll()
  }

  async function exportSelectedWorkorder() {
    if (!selectedWorkorder) {
      setStatus('Select a workorder to export.')
      return
    }
    const res = await apiFetch(`${API}/workorders/${selectedWorkorder.id}/export`)
    if (!res.ok) {
      setStatus('Failed to export workorder.')
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

  return (
    <main className="workorders-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Workorders</p>
          <h1>Separate intake, diagnosis, and invoice flow.</h1>
        </div>
        <div className="stats-grid">
          <div><strong>{customers.length}</strong><span>Customers</span></div>
          <div><strong>{equipment.length}</strong><span>Machines</span></div>
          <div><strong>{workorders.length}</strong><span>Workorders</span></div>
          <div><strong>{parts.length}</strong><span>Parts linked</span></div>
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
          <p>Windows can use this as a browser/PWA install. Android can use the Capacitor app package.</p>
        </div>
      </section>

      <div className="tab-row">
        <button className={activeTab === 'intake' ? 'active-tab' : ''} onClick={() => setActiveTab('intake')}>Drop-Off Intake</button>
        <button className={activeTab === 'diagnose' ? 'active-tab' : ''} onClick={() => setActiveTab('diagnose')}>Diagnose & Quote</button>
        <button className={activeTab === 'invoice' ? 'active-tab' : ''} onClick={() => setActiveTab('invoice')}>Work Done & Invoice</button>
      </div>

      <section className="work-grid">
        <div className="panel">
          <h2>Workorders</h2>
          <div className="picker-list">
            {workorders.map((workorder) => (
              <button
                key={workorder.id}
                className={String(selectedWorkorderId) === String(workorder.id) ? 'selected-item' : ''}
                onClick={() => setSelectedWorkorderId(String(workorder.id))}
              >
                {workorder.number} - {workorder.title} ({workorder.status})
              </button>
            ))}
            {workorders.length === 0 && <div className="empty-state">No workorders yet.</div>}
          </div>
        </div>

        {activeTab === 'intake' && (
          <div className="contact-grid">
            <div className="panel">
              <h2>Customer Contacts</h2>
              <div className="picker-list">
                {customerOptions.map((customer) => (
                  <button
                    key={customer.id}
                    className={customer.selected ? 'selected-item' : ''}
                    onClick={() => {
                      setSelectedCustomerId(String(customer.id))
                      updateForm(setMachineForm, 'customerId', String(customer.id))
                      updateForm(setWorkorderForm, 'customerId', String(customer.id))
                    }}
                  >
                    {customer.name} {customer.phone ? `- ${customer.phone}` : ''}
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
                    <button
                      className="dictate-button"
                      onClick={() => startDictation('machine', 'unitNumber', setMachineForm)}
                      type="button"
                    >
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
                    <button className="dictate-button" onClick={() => startDictation('machine', 'make', setMachineForm)} type="button">
                      {dictatingField === 'machine:make' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  Model
                  <div className="voice-grid">
                    <input value={machineForm.model} onChange={(e) => updateForm(setMachineForm, 'model', e.target.value)} />
                    <button className="dictate-button" onClick={() => startDictation('machine', 'model', setMachineForm)} type="button">
                      {dictatingField === 'machine:model' ? 'Listening...' : 'Voice'}
                    </button>
                  </div>
                </label>
                <label>
                  Serial Number
                  <div className="voice-grid">
                    <input value={machineForm.serial} onChange={(e) => updateForm(setMachineForm, 'serial', e.target.value)} />
                    <button className="dictate-button" onClick={() => startDictation('machine', 'serial', setMachineForm)} type="button">
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
                    <button className="dictate-button" onClick={() => startDictation('machine', 'notes', setMachineForm)} type="button">
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
                    <button className="dictate-button" onClick={() => startDictation('workorder', 'complaint', setWorkorderForm)} type="button">
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
                <div className="field-grid">
                  <label>
                    Status
                    <select value={workorderForm.status || selectedWorkorder.status} onChange={(e) => updateForm(setWorkorderForm, 'status', e.target.value)}>
                      <option value="open">Open</option>
                      <option value="in progress">In Progress</option>
                      <option value="waiting parts">Waiting Parts</option>
                      <option value="complete">Complete</option>
                      <option value="invoiced">Invoiced</option>
                    </select>
                  </label>
                  <label>
                    Labor Hours
                    <input type="number" min="0" step="0.1" value={workorderForm.laborHours || selectedWorkorder.laborHours || 0} onChange={(e) => updateForm(setWorkorderForm, 'laborHours', e.target.value)} />
                  </label>
                  <label>
                    Labor Rate
                    <input type="number" min="0" step="0.01" value={workorderForm.laborRate || selectedWorkorder.laborRate || 0} onChange={(e) => updateForm(setWorkorderForm, 'laborRate', e.target.value)} />
                  </label>
                  <label className="full-span">
                    Diagnosis
                    <div className="voice-grid">
                      <textarea value={workorderForm.diagnosis || selectedWorkorder.diagnosis || ''} onChange={(e) => updateForm(setWorkorderForm, 'diagnosis', e.target.value)} />
                      <button className="dictate-button" onClick={() => startDictation('workorder', 'diagnosis', setWorkorderForm)} type="button">
                        {dictatingField === 'workorder:diagnosis' ? 'Listening...' : 'Voice'}
                      </button>
                    </div>
                  </label>
                </div>
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
                            {part.name} - avail {part.availableQty ?? part.quantity}
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
                        <button className="dictate-button" onClick={() => startDictation('part', 'note', setPartForm)} type="button">
                          {dictatingField === 'part:note' ? 'Listening...' : 'Voice'}
                        </button>
                      </div>
                    </label>
                  </div>
                  <button className="primary-action" onClick={addPartToWorkorder}>Add Part</button>
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
                  <div><span>Customer</span><strong>{selectedWorkorder.customerName || 'None'}</strong></div>
                  <div><span>Machine</span><strong>{selectedWorkorder.equipmentName || 'None'}</strong></div>
                  <div><span>Status</span><strong>{selectedWorkorder.status}</strong></div>
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
                    Labor Notes
                    <div className="voice-grid">
                      <textarea value={workorderForm.laborNotes || selectedWorkorder.laborNotes || ''} onChange={(e) => updateForm(setWorkorderForm, 'laborNotes', e.target.value)} />
                      <button className="dictate-button" onClick={() => startDictation('workorder', 'laborNotes', setWorkorderForm)} type="button">
                        {dictatingField === 'workorder:laborNotes' ? 'Listening...' : 'Voice'}
                      </button>
                    </div>
                  </label>
                  <div className="parts-list">
                    {workorderParts.map((item) => (
                      <div key={item.id}>
                        <span><strong>{item.partName}</strong> x {item.qtyUsed || item.qtyReserved}</span>
                        <span>${(Number(item.qtyUsed || 0) * Number(item.retailPrice || 0)).toFixed(2)}</span>
                      </div>
                    ))}
                    {workorderParts.length === 0 && <div className="empty-state">No parts on this workorder yet.</div>}
                  </div>
                  <div className="summary-list">
                    <div><span>Parts</span><strong>${invoiceTotals.partsRetail.toFixed(2)}</strong></div>
                    <div><span>Labor</span><strong>${invoiceTotals.labor.toFixed(2)}</strong></div>
                  </div>
                  <div className="invoice-total">
                    <span>Total</span>
                    <strong>${invoiceTotals.total.toFixed(2)}</strong>
                  </div>
                  <button onClick={exportSelectedWorkorder}>Export for Email</button>
                </>
              ) : (
                <div className="empty-state">Select a workorder first.</div>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
