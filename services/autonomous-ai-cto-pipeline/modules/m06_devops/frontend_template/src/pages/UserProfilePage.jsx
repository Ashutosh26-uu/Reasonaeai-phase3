import { useState } from 'react';

function UserProfilePage() {
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchProfile = async () => {
    setLoading(true);
    setError('');
    setUserData(null);
    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('Please log in first');
      const response = await fetch('http://127.0.0.1:8000/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Could not load profile. Try logging in again.');
      setUserData(await response.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h2><span className="module-tag">03</span>My profile</h2>
      <button className="btn" onClick={fetchProfile} disabled={loading}>
        {loading ? 'LOADING...' : 'LOAD MY PROFILE'}
      </button>
      {error && <div className="message error">{error}</div>}
      {userData && (
        <div className="message success">
          <div className="result-row"><span>id</span><span>{userData.id}</span></div>
          <div className="result-row"><span>email</span><span>{userData.email}</span></div>
        </div>
      )}
    </div>
  );
}

export default UserProfilePage;