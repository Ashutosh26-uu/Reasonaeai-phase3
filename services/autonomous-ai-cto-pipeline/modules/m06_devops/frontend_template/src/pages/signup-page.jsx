import { useCallback, useState } from "react";

function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

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
      setResult(null);
      try {
        const response = await fetch("http://127.0.0.1:8000/auth/signup", {
          body: JSON.stringify({ email, password }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof data.detail === "string" ? data.detail : "Invalid input"
          );
        }
        setResult(data);
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
        <span className="module-tag">01</span>Create account
      </h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="signup-email">EMAIL</label>
          <input
            id="signup-email"
            onChange={handleEmailChange}
            required
            type="email"
            value={email}
          />
        </div>
        <div className="field">
          <label htmlFor="signup-password">PASSWORD</label>
          <input
            id="signup-password"
            onChange={handlePasswordChange}
            required
            type="password"
            value={password}
          />
        </div>
        <button className="btn" disabled={loading} type="submit">
          {loading ? "CREATING..." : "SIGN UP"}
        </button>
      </form>
      {error && <div className="message error">{error}</div>}
      {result && (
        <div className="message success">
          <div className="result-row">
            <span>id</span>
            <span>{result.id}</span>
          </div>
          <div className="result-row">
            <span>email</span>
            <span>{result.email}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default SignupPage;
