"""
Frontend Orchestrator (v2 - page-type detection + concrete examples).

Same idea as the backend orchestrator: generate React component code,
check if it's syntactically valid JSX, and if not, send the error back
to the AI to fix automatically. Retries a few times before giving up.

Validation uses esbuild (via npx) since it understands JSX syntax and
is very fast - much lighter than setting up a full build pipeline just
to check syntax.

Changes in v2:
  - each page in frontend_api_spec.json now gets a detected/declared
    "page_type": "form", "list", or "upload". A page can set
    "page_type" explicitly, or it is inferred from calls_api
    (a "query_params" key means "list", a "file_field_name" key or
    "is_file_upload": true means "upload", otherwise "form").
  - the prompt for each type includes a concrete, WORKING example JSX
    component in that exact style, using the project's existing CSS
    classes (panel / field / btn / message / result-row), so generated
    pages come out styled correctly without manual fixing afterwards.
  - this replaces relying on text-only rules, which the 7B model did
    not reliably follow for styling and for non-form page shapes.
"""

import ollama
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime

# Speed / reliability settings (all overridable with environment variables).
#   CTO_FRONTEND_MODEL   - Ollama model for the frontend agent (a smaller model such as
#                          qwen2.5-coder:3b is 2-3x faster on a CPU-only laptop)
#   CTO_FRONTEND_MODE    - "llm" (default) or "template" (instant, no model call)
CODER_MODEL = os.environ.get("CTO_FRONTEND_MODEL", os.environ.get("CTO_MODEL", "qwen2.5-coder:7b"))
FRONTEND_MODE = os.environ.get("CTO_FRONTEND_MODE", "template").lower()  # "template" = instant; set CTO_FRONTEND_MODE=llm to use the model
MAX_ATTEMPTS = 1
MAX_OUTPUT_TOKENS = 1200      # one page of JSX is ~500-800 tokens; stops runaway generation
ATTEMPT_TIMEOUT_SECONDS = 120  # give up on one model call after 2 minutes (was 10)

KNOWN_RULES = """
- Use React functional components with hooks (useState).
- Use the built-in fetch() function to call the API - do NOT use axios.
- Show a loading state while the request is in progress.
- Show a clear error message if the request fails.
- Show the result on screen after a successful request.
- Export the component as the default export using "export default ComponentName;"
  at the end of the file.
- Import React and useState at the top: "import React, { useState } from 'react';"
- Do NOT use useEffect for data fetching triggered by a button click - only
  fetch when the user explicitly clicks a button.
- Use these existing CSS classes for consistent styling - do NOT invent
  new class names and do NOT write inline styles:
  - Wrap the whole component in <div className="panel">.
  - Wrap each input with its label in
    <div className="field"><label>LABEL</label><input .../></div>.
  - Use <button className="btn"> for every button.
  - Show errors as <div className="message error">...</div>.
  - Show success/results as <div className="message success">...</div>,
    with one <div className="result-row"><span>field</span><span>{value}</span></div>
    per field shown inside it.
- Output ONLY the raw JavaScript/JSX code for this ONE component.
- Do NOT include any explanation, markdown formatting, or code fences.
  If you accidentally start writing an explanation, stop immediately - the
  file must contain nothing but valid, runnable JSX code.
"""

FORM_PAGE_EXAMPLE = """
This page is a FORM page (create/submit a single record). Here is a
WORKING EXAMPLE showing the exact style and structure to follow. Adapt
the field names, labels, and API details to the actual page being
generated - do not copy this example's field names unless they match.

import React, { useState } from 'react';

function CreateItemPage() {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('http://127.0.0.1:8000/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, price, description }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : 'Request failed');
      }
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h2>Create item</h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>NAME</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label>PRICE</label>
          <input value={price} onChange={(e) => setPrice(e.target.value)} required />
        </div>
        <div className="field">
          <label>DESCRIPTION</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={loading}>
          {loading ? 'SAVING...' : 'SAVE'}
        </button>
      </form>
      {error && <div className="message error">{error}</div>}
      {result && (
        <div className="message success">
          <div className="result-row"><span>id</span><span>{result.id}</span></div>
        </div>
      )}
    </div>
  );
}

export default CreateItemPage;
"""

LIST_PAGE_EXAMPLE = """
This page is a LIST/SEARCH page, not a form - it fetches and displays
multiple records with optional filters and pagination. Here is a
WORKING EXAMPLE showing the exact style and structure to follow. Adapt
the filter fields, the fields shown per item, and API details to the
actual page being generated.

import React, { useState } from 'react';

function ItemListPage() {
  const [items, setItems] = useState([]);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [limit] = useState(10);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchItems = async (newOffset) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (minPrice) params.append('min_price', minPrice);
      if (maxPrice) params.append('max_price', maxPrice);
      params.append('limit', limit);
      params.append('offset', newOffset);
      const response = await fetch('http://127.0.0.1:8000/items?' + params.toString());
      if (!response.ok) throw new Error('Could not load items');
      const data = await response.json();
      setItems(data);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h2>Items</h2>
      <div className="field">
        <label>MIN PRICE</label>
        <input value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
      </div>
      <div className="field">
        <label>MAX PRICE</label>
        <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
      </div>
      <button className="btn" onClick={() => fetchItems(0)} disabled={loading}>
        {loading ? 'LOADING...' : 'SEARCH'}
      </button>
      {error && <div className="message error">{error}</div>}
      {items.map((item) => (
        <div className="message success" key={item.id}>
          <div className="result-row"><span>id</span><span>{item.id}</span></div>
        </div>
      ))}
      <button className="btn" onClick={() => fetchItems(Math.max(0, offset - limit))} disabled={offset === 0}>
        PREVIOUS
      </button>
      <button className="btn" onClick={() => fetchItems(offset + limit)}>
        NEXT
      </button>
    </div>
  );
}

export default ItemListPage;
"""

UPLOAD_PAGE_EXAMPLE = """
This page is a FILE UPLOAD page. Here is a WORKING EXAMPLE showing the
exact style and structure to follow. Adapt the target id field and API
path to the actual page being generated. Use FormData for the request
body - do NOT set a Content-Type header manually, the browser sets it
automatically with the correct multipart boundary.

import React, { useState } from 'react';

function UploadImagePage() {
  const [id, setId] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('http://127.0.0.1:8000/items/' + id + '/upload', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) throw new Error('Upload failed');
      setSuccess(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h2>Upload file</h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>ID</label>
          <input value={id} onChange={(e) => setId(e.target.value)} required />
        </div>
        <div className="field">
          <label>FILE</label>
          <input type="file" onChange={(e) => setFile(e.target.files[0])} required />
        </div>
        <button className="btn" type="submit" disabled={loading}>
          {loading ? 'UPLOADING...' : 'UPLOAD'}
        </button>
      </form>
      {error && <div className="message error">{error}</div>}
      {success && <div className="message success">Upload successful.</div>}
    </div>
  );
}

export default UploadImagePage;
"""


def _detect_page_type(page: dict) -> str:
    """
    A page can declare "page_type": "form" | "list" | "upload" explicitly
    in frontend_api_spec.json. If it does not, infer it from calls_api:
    a "query_params" key means "list", a "file_field_name" key or
    "is_file_upload": true means "upload", otherwise "form". This keeps
    older spec files (with no page_type field) working unchanged.
    """
    declared = page.get("page_type")
    if declared in ("form", "list", "upload"):
        return declared
    calls_api = page.get("calls_api", {})
    if "query_params" in calls_api:
        return "list"
    if calls_api.get("file_field_name") or calls_api.get("is_file_upload"):
        return "upload"
    return "form"


def _example_for(page_type: str) -> str:
    if page_type == "list":
        return LIST_PAGE_EXAMPLE
    if page_type == "upload":
        return UPLOAD_PAGE_EXAMPLE
    return FORM_PAGE_EXAMPLE


def _log(build_log: list, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry = f"[{timestamp}] {message}"
    build_log.append(entry)
    print(entry)


def _clean_code(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text.replace("jsx", "", 1).replace("javascript", "", 1).strip()
    if "```" in text:
        text = text.split("```")[0].strip()
    return text


def _is_valid_jsx(code: str):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsx", delete=False) as tmp:
        tmp.write(code)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["esbuild", tmp_path],
            capture_output=True,
            text=True,
            timeout=30,
            shell=True,
        )
        if result.returncode == 0:
            return True, ""
        else:
            return False, result.stderr or result.stdout
    except subprocess.TimeoutExpired:
        return False, "Validation took too long"
    finally:
        os.remove(tmp_path)


_PAGE_TEMPLATE = """import React, { useState } from 'react';

const IMAGE_RE = /^(https?:|data:image|[/]).*(png|jpe?g|gif|webp|svg)([?].*)?$/i;

function Value({ v }) {
  if (v === null || v === undefined || v === '') return <span className="muted">-</span>;
  if (Array.isArray(v)) {
    return (
      <div className="chip-list">
        {v.map((x, i) => (typeof x === 'object' && x !== null
          ? <pre className="json" key={i}>{JSON.stringify(x, null, 2)}</pre>
          : <Value v={x} key={i} />))}
      </div>
    );
  }
  if (typeof v === 'object') return <pre className="json">{JSON.stringify(v, null, 2)}</pre>;
  if (typeof v === 'string' && IMAGE_RE.test(v)) return <img className="thumb" src={v} alt="" />;
  return <span className="value-chip">{String(v)}</span>;
}

function Record({ data }) {
  if (data === null || typeof data !== 'object') return <div className="record"><Value v={data} /></div>;
  return (
    <div className="record">
      {Object.entries(data).map(([k, v]) => (
        <div className="result-row" key={k}>
          <span>{k.replace(/_/g, ' ')}</span>
          <Value v={v} />
        </div>
      ))}
    </div>
  );
}

function __NAME__() {
  const [values, setValues] = useState(__INITIAL__);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const setField = (key, value) => setValues({ ...values, [key]: value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      let url = __URL__;
__QUERY__      const headers = { 'Content-Type': 'application/json' };
      const token = localStorage.getItem('token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const response = await fetch(url, {
        method: '__METHOD__',
        headers,
__BODY__      });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : { status: 'done' };
      } catch (parseError) {
        data = { response: text };
      }
      if (!response.ok) {
        const detail = data && data.detail;
        throw new Error(typeof detail === 'string' ? detail : (response.status === 404 ? 'Not found - check the ID and try again.' : 'Request failed (' + response.status + ')'));
      }
      if (data && data.access_token) localStorage.setItem('token', data.access_token);
      setResult(data);
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'Cannot reach the backend. Is it running?' : err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h2>__TITLE__</h2>
      <p className="panel-hint">__HINT__</p>
      <form onSubmit={handleSubmit}>
__FIELDS__        <button className="btn" type="submit" disabled={loading}>
          {loading ? 'Working...' : '__BUTTON__'}
        </button>
      </form>
      {error && <div className="message error">{error}</div>}
      {result && Array.isArray(result) && result.length === 0 && (
        <div className="message">Nothing found yet.</div>
      )}
      {result && Array.isArray(result) && result.map((item, i) => (
        <div className="message success" key={i}><Record data={item} /></div>
      ))}
      {result && !Array.isArray(result) && (
        <div className="message success"><Record data={result} /></div>
      )}
    </div>
  );
}

export default __NAME__;
"""


def _template_page(page: dict) -> str:
    """
    Deterministic (no model call) page generator in the same visual style as
    the LLM pages. Used when the model times out / keeps producing invalid
    JSX, or when CTO_FRONTEND_MODE=template.
    """
    api = page.get("calls_api", {}) or {}
    method = str(api.get("method", "GET")).upper()
    path = api.get("path", "/")
    base = api.get("base_url", "http://127.0.0.1:8000")
    body = api.get("request_body") or {}
    query = api.get("query_params") or {}
    if isinstance(query, list):
        query = {name: "string" for name in query}

    path_params = re.findall(r"\{(\w+)\}", path)
    # If the URL has {id} and the body already asks for '<something>_id', show ONE field
    # (avoids the confusing "ID" + "SERVICE ID" pair) and use it in the URL too.
    url_alias = {}
    id_like = [k for k in body if k.endswith("_id")]
    if path_params == ["id"] and len(id_like) == 1:
        url_alias["id"] = id_like[0]
        path_params = []
    fields = []  # (key, type)
    for key in path_params:
        fields.append((key, "string"))
    for key, kind in body.items():
        if key not in [f[0] for f in fields]:
            fields.append((key, str(kind)))
    for key, kind in query.items():
        if key not in [f[0] for f in fields]:
            fields.append((key, str(kind)))

    parts = re.split(r"\{(\w+)\}", path)
    pieces = []
    for index, part in enumerate(parts):
        if index % 2 == 0:
            if part:
                pieces.append(json.dumps(part))
        else:
            pieces.append(f"encodeURIComponent(values[{json.dumps(url_alias.get(part, part))}])")
    url_expr = " + ".join([json.dumps(base)] + pieces)

    query_code = ""
    if query:
        query_code = "      const params = new URLSearchParams();\n"
        for key in query:
            query_code += (
                f"      if (values[{json.dumps(key)}]) "
                f"params.append({json.dumps(key)}, values[{json.dumps(key)}]);\n"
            )
        query_code += "      if (params.toString()) url += '?' + params.toString();\n"

    body_code = ""
    if body and method in ("POST", "PUT", "PATCH"):
        items = []
        for key, kind in body.items():
            ref = f"values[{json.dumps(key)}]"
            if str(kind) in ("integer", "number", "float", "int"):
                value = f"{ref} === '' ? undefined : Number({ref})"
            elif str(kind) in ("boolean", "bool"):
                value = f"{ref} === 'true'"
            else:
                value = ref
            items.append(f"{json.dumps(key)}: {value}")
        body_code = "        body: JSON.stringify({ " + ", ".join(items) + " }),\n"

    field_code = ""
    for key, kind in fields:
        input_type = "password" if "password" in key.lower() else "text"
        if str(kind) in ("integer", "number", "float", "int") and key not in query:
            input_type = "number"
        label = key.replace("_", " ").upper()
        required = key in path_params or key in url_alias.values()
        optional = key in query
        if optional:
            hint = "Optional"
        elif key.endswith("id"):
            hint = "e.g. 1"
        elif "message" in key.lower() or "description" in key.lower():
            hint = "Type here..."
        else:
            hint = f"Enter {key.replace('_', ' ')}"
        req_attr = " required" if (required and method != "DELETE") or (method in ("POST", "PUT", "PATCH") and not optional) else ""
        if any(w in key.lower() for w in ("message", "description", "notes", "content", "body")) and input_type == "text":
            control = (
                f"<textarea rows={{4}} placeholder={json.dumps(hint)}{req_attr} value={{values[{json.dumps(key)}]}} "
                f"onChange={{(e) => setField({json.dumps(key)}, e.target.value)}} />"
            )
        else:
            control = (
                f"<input type=\"{input_type}\" placeholder={json.dumps(hint)}{req_attr} value={{values[{json.dumps(key)}]}} "
                f"onChange={{(e) => setField({json.dumps(key)}, e.target.value)}} />"
            )
        field_code += (
            "        <div className=\"field\">\n"
            f"          <label>{label}{' (optional)' if optional else ''}</label>\n"
            f"          {control}\n"
            "        </div>\n"
        )

    name = page["name"]
    title = re.sub(r"(?<!^)(?=[A-Z])", " ", name)
    title = title[:-5] if title.endswith(" Page") else title
    button = {"POST": "Submit", "PUT": "Save", "PATCH": "Save", "DELETE": "Delete"}.get(method, "Load")
    hint = (page.get("description") or "").strip() or "Fill the form and press the button."

    code = _PAGE_TEMPLATE
    for placeholder, value in {
        "__NAME__": name,
        "__INITIAL__": json.dumps({key: "" for key, _ in fields}),
        "__URL__": url_expr,
        "__QUERY__": query_code,
        "__METHOD__": method,
        "__BODY__": body_code,
        "__TITLE__": title,
        "__FIELDS__": field_code,
        "__BUTTON__": button,
        "__HINT__": hint.replace("{", "(").replace("}", ")").replace("<", "").replace(">", ""),
    }.items():
        code = code.replace(placeholder, value)
    return code


def _chat_with_limits(conversation: list) -> str:
    """One model call with an output cap and a wall-clock timeout."""
    client = ollama.Client(timeout=ATTEMPT_TIMEOUT_SECONDS)
    response = client.chat(
        model=CODER_MODEL,
        messages=conversation,
        options={"num_predict": MAX_OUTPUT_TOKENS, "temperature": 0.2},
    )
    return response["message"]["content"]


def generate_frontend_code(spec_file: str = "frontend_api_spec.json") -> bool:
    build_log = []

    if not os.path.exists(spec_file):
        raise FileNotFoundError(f"Spec file not found: {spec_file}")

    with open(spec_file, "r") as file:
        spec_data = json.load(file)

    output_folder = "generated_frontend"
    os.makedirs(output_folder, exist_ok=True)

    all_succeeded = True

    for page in spec_data["pages"]:
        page_name = page["name"]
        page_type = _detect_page_type(page)
        output_path = os.path.join(output_folder, f"{page_name}.jsx")

        # Resume support: keep pages that an earlier run already finished.
        if FRONTEND_MODE == "llm" and os.path.exists(output_path):
            with open(output_path, encoding="utf-8") as existing:
                already_ok, _ = _is_valid_jsx(existing.read())
            if already_ok:
                _log(build_log, f"Frontend Agent: '{page_name}' already generated earlier, skipping. \u2705")
                continue

        _log(build_log, f"Frontend Agent: starting page '{page_name}' (type: {page_type})")

        base_prompt = f"""
You are a React developer. Generate a single React functional component
based on the following specification.

Page name: {page_name}
Description: {page["description"]}
API it should call: {json.dumps(page["calls_api"], indent=2)}

Requirements:
{KNOWN_RULES}
{_example_for(page_type)}
"""

        conversation = [{"role": "user", "content": base_prompt}]
        final_code = None
        used_template = False

        if FRONTEND_MODE != "template":
            for attempt in range(1, MAX_ATTEMPTS + 1):
                if attempt == 1:
                    _log(build_log, f"Frontend Agent: generating '{page_name}' for the first time...")
                else:
                    _log(build_log, f"Frontend Agent: fixing '{page_name}' (attempt {attempt}/{MAX_ATTEMPTS})...")

                try:
                    raw_output = _chat_with_limits(conversation)
                except Exception as exc:  # timeout, connection reset, model error
                    _log(build_log, f"Frontend Agent: model call failed for '{page_name}' - {type(exc).__name__}")
                    continue

                code = _clean_code(raw_output)

                _log(build_log, f"Frontend Agent: checking if '{page_name}' is valid JSX...")
                is_valid, error_message = _is_valid_jsx(code)

                if is_valid:
                    _log(build_log, f"Frontend Agent: '{page_name}' is valid. \u2705")
                    final_code = code
                    break
                else:
                    last_line = error_message.strip().splitlines()[-1] if error_message.strip() else "unknown error"
                    _log(build_log, f"Frontend Agent: found a problem in '{page_name}' \u2014 {last_line}")
                    conversation.append({"role": "assistant", "content": raw_output})
                    conversation.append({
                        "role": "user",
                        "content": f"That code has a syntax error:\n{error_message}\n\nPlease output the complete, corrected JSX file. Output ONLY the raw code, nothing else."
                    })

        if not final_code:
            template_code = _template_page(page)
            template_ok, template_error = _is_valid_jsx(template_code)
            if template_ok:
                reason = "template mode" if FRONTEND_MODE == "template" else "the model did not finish in time"
                _log(build_log, f"Frontend Agent: built '{page_name}' from the built-in template ({reason}). \u2705")
                final_code = template_code
                used_template = True

        if final_code:
            with open(output_path, "w", encoding="utf-8") as file:
                file.write(final_code)
            _log(build_log, f"Frontend Agent: saved '{page_name}' to {output_path}")
        else:
            _log(build_log, f"Frontend Agent: \u274c could not produce valid code for '{page_name}'.")
            all_succeeded = False

    log_path = os.path.join(output_folder, "build_log.json")
    with open(log_path, "w", encoding="utf-8") as file:
        json.dump({"success": all_succeeded, "steps": build_log}, file, indent=2)

    return all_succeeded


if __name__ == "__main__":
    generate_frontend_code()