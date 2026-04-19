import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="page-placeholder">
      <h1>404</h1>
      <p>Page not found.</p>
      <Link to="/">Back to home</Link>
    </div>
  );
}
