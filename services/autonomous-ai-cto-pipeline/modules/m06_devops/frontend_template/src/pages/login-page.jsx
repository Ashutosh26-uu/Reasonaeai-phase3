import { useCallback, useState } from "react";

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleEmailChange = useCallback((e) => setEmail(e.target.value), []);
  const handlePasswordChange = useCallback(
    (e) => setPassword(e.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setLoading(true);
      setError("");
      setSuccess(false);
      try {
        const response = await fetch("http://127.0.0.1:8000/auth/login", {
          body: JSON.stringify({ email, password }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof data.detail === "string" ? data.detail : "Login failed"
          );
        }
        localStorage.setItem("access_token", data.access_token);
        setSuccess(true);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [email, password]
  );

  return (
    <div className="panel">
      <h2>
        <span className="module-tag">02</span>Log in
      </h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="login-email">EMAIL</label>
          <input
            id="login-email"
            onChange={handleEmailChange}
            required
            type="email"
            value={email}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">PASSWORD</label>
          <input
            id="login-password"
            onChange={handlePasswordChange}
            required
            type="password"
            value={password}
          />
        </div>
        <button className="btn" disabled={loading} type="submit">
          {loading ? "LOGGING IN..." : "LOG IN"}
        </button>
      </form>
      {error && <div className="message error">{error}</div>}
      {success && (
        <div className="message success">Login successful. Token saved.</div>
      )}
    </div>
  );
}

export default LoginPage;
