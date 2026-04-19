import { useEffect, useMemo, useState } from 'react'

const API = 'http://localhost:3001/api'

export default function App() {
  const [parts, setParts] = useState([])
  const [locations, setLocations] = useState([])
  const [categories, setCategories] = useState([])
  const [search, setSearch] = useState('')

  const [partName, setPartName] = useState('')
  const [qty, setQty] = useState(1)
  const [partLocationId, setPartLocationId] = useState('')
  const [partCategoryId, setPartCategoryId] = useState('')

  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationType, setNewLocationType] = useState('bin')
  const [newLocationParentId, setNewLocationParentId] = useState('')

  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryParentId, setNewCategoryParentId] = useState('')

  async function loadAll() {
    const [p, l, c] = await Promise.all([
      fetch(`${API}/parts`),
      fetch(`${API}/locations`),
      fetch(`${API}/categories`)
    ])

    setParts(await p.json())
    setLocations(await l.json())
    setCategories(await c.json())
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function addPart() {
    if (!partName.trim()) return

    await fetch(`${API}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: partName.trim(),
        quantity: qty,
        locationId: partLocationId ? Number(partLocationId) : null,
        categoryId: partCategoryId ? Number(partCategoryId) : null
      })
    })

    setPartName('')
    setQty(1)
    setPartLocationId('')
    setPartCategoryId('')
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
    loadAll()
  }

  async function deleteCategory(id, name) {
    const ok = window.confirm(`Delete category "${name}"?`)
    if (!ok) return

    const res = await fetch(`${API}/categories/${id}`, {
      method: 'DELETE'
    })

    const data = await res.json()

    if (!res.ok) {
      alert(data.error || 'Failed to delete category')
      return
    }

    loadAll()
  }

  async function deleteLocation(id, name) {
    const ok = window.confirm(`Delete location "${name}"?`)
    if (!ok) return

    const res = await fetch(`${API}/locations/${id}`, {
      method: 'DELETE'
    })

    const data = await res.json()

    if (!res.ok) {
      alert(data.error || 'Failed to delete location')
      return
    }

    loadAll()
  }

  async function checkout(id) {
    await fetch(`${API}/parts/${id}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty: 1 })
    })
    loadAll()
  }

  async function returnPart(id) {
    await fetch(`${API}/parts/${id}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty: 1 })
    })
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

  const filteredParts = parts.filter((p) => {
    const q = search.trim().toLowerCase()
    if (!q) return true

    const name = (p.name || '').toLowerCase()
    const cat = getPath(p.categoryId, catMap).toLowerCase()
    const loc = getPath(p.locationId, locMap).toLowerCase()

    return name.includes(q) || cat.includes(q) || loc.includes(q)
  })

  return (
    <div style={{ padding: 20, maxWidth: 1300, margin: '0 auto' }}>
      <h1>Inventory System</h1>

      <div style={{ marginBottom: 20 }}>
        <input
          placeholder="Search parts, categories, or locations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 500, padding: 8 }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 30 }}>
        <div style={{ border: '1px solid #555', padding: 16 }}>
          <h2>Add Category</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              placeholder="Category name"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
            />
            <select
              value={newCategoryParentId}
              onChange={(e) => setNewCategoryParentId(e.target.value)}
            >
              <option value="">No Parent</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {getPath(c.id, catMap)}
                </option>
              ))}
            </select>
            <button onClick={addCategory}>Add Category</button>
          </div>
        </div>

        <div style={{ border: '1px solid #555', padding: 16 }}>
          <h2>Add Location</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              placeholder="Location name"
              value={newLocationName}
              onChange={(e) => setNewLocationName(e.target.value)}
            />
            <select
              value={newLocationType}
              onChange={(e) => setNewLocationType(e.target.value)}
            >
              <option value="room">Room</option>
              <option value="section">Section</option>
              <option value="shelf">Shelf</option>
              <option value="rack">Rack</option>
              <option value="bin">Bin</option>
              <option value="drawer">Drawer</option>
            </select>
            <select
              value={newLocationParentId}
              onChange={(e) => setNewLocationParentId(e.target.value)}
            >
              <option value="">No Parent</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {getPath(l.id, locMap)}
                </option>
              ))}
            </select>
            <button onClick={addLocation}>Add Location</button>
          </div>
        </div>

        <div style={{ border: '1px solid #555', padding: 16 }}>
          <h2>Add Part</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              placeholder="Part name"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
            />
            <input
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
            />
            <select
              value={partCategoryId}
              onChange={(e) => setPartCategoryId(e.target.value)}
            >
              <option value="">No Category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {getPath(c.id, catMap)}
                </option>
              ))}
            </select>
            <select
              value={partLocationId}
              onChange={(e) => setPartLocationId(e.target.value)}
            >
              <option value="">No Location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {getPath(l.id, locMap)}
                </option>
              ))}
            </select>
            <button onClick={addPart}>Add Part</button>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 30 }}>
        <h2>Categories</h2>
        {categories.length === 0 ? (
          <div>No categories yet.</div>
        ) : (
          categories.map((c) => (
            <div key={c.id} style={{ border: '1px solid #444', padding: 10, marginBottom: 8 }}>
              <strong>{c.name}</strong> — Parent: {c.parentId ? getPath(c.parentId, catMap) : 'None'}
              <button
                style={{ marginLeft: 12 }}
                onClick={() => deleteCategory(c.id, c.name)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      <div style={{ marginBottom: 30 }}>
        <h2>Locations</h2>
        {locations.length === 0 ? (
          <div>No locations yet.</div>
        ) : (
          locations.map((l) => (
            <div key={l.id} style={{ border: '1px solid #444', padding: 10, marginBottom: 8 }}>
              <strong>{l.name}</strong> — {l.type} — Parent: {l.parentId ? getPath(l.parentId, locMap) : 'None'}
              <button
                style={{ marginLeft: 12 }}
                onClick={() => deleteLocation(l.id, l.name)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      <div style={{ marginBottom: 30 }}>
        <h2>Parts</h2>
        {filteredParts.length === 0 ? (
          <div>No matching parts.</div>
        ) : (
          filteredParts.map((p) => (
            <div key={p.id} style={{ border: '1px solid #ccc', padding: 12, marginBottom: 10 }}>
              <strong>{p.name}</strong>
              <div>Qty: {p.quantity}</div>
              <div>Category: {getPath(p.categoryId, catMap)}</div>
              <div>Location: {getPath(p.locationId, locMap)}</div>
              <button onClick={() => checkout(p.id)}>Checkout</button>
              <button onClick={() => returnPart(p.id)} style={{ marginLeft: 10 }}>
                Return
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
