import { getOrCreateClient } from 'concave/client';
import { useAuth, useLiveList } from 'concave/client/react';
import { AuthForm } from './components/AuthForm';
import type { Todo, User } from './generated/api-types';
import { useState, useEffect } from 'react';

// Initialize client once (HMR-safe)
const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: 'include',
  offline: true,
});

export function App() {
  const { user, isLoading, isAuthenticated, logout } = useAuth<User>();

  // Set auth error handler (redirects to login on 401)
  useEffect(() => {
    client.setAuthErrorHandler(logout);
  }, [logout]);

  if (isLoading) {
    return (
      <div className="container">
        <div className="card">
          <div className="content" style={{ textAlign: 'center', padding: 40 }}>
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <AuthForm onLogin={() => window.location.reload()} />;
  }

  return <TodoApp user={user} onLogout={logout} />;
}

function TodoApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [newTodo, setNewTodo] = useState('');
  const { items: todos, status, statusLabel, mutate } = useLiveList<Todo>(
    '/api/todos',
    { orderBy: 'position' }
  );

  const addTodo = () => {
    if (!newTodo.trim()) return;
    mutate.create({ title: newTodo.trim() } as Omit<Todo, 'id'>);
    setNewTodo('');
  };

  const completedCount = todos.filter((t) => t.completed).length;

  return (
    <div className="container">
      <div className="card">
        <div className="header">
          <h1>My Todos</h1>
          <p>Stay organized, get things done</p>
        </div>
        <div className="user-bar">
          <span>Hi, {user.name}!</span>
          <button onClick={onLogout}>Sign out</button>
        </div>
        <div className="content">
          <div className="todo-input-row">
            <input
              type="text"
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTodo()}
              placeholder="What needs to be done?"
            />
            <button className="btn btn-primary" onClick={addTodo}>Add</button>
          </div>

          {todos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🎉</div>
              <p>No todos yet. Add one above!</p>
            </div>
          ) : (
            <ul className="todo-list">
              {todos.map((todo) => (
                <li key={todo.id} className="todo-item">
                  <div
                    className={`todo-checkbox${todo.completed ? ' checked' : ''}`}
                    onClick={() => mutate.update(todo.id, { completed: !todo.completed })}
                  />
                  <span className={`todo-title${todo.completed ? ' completed' : ''}`}>
                    {todo.title}
                  </span>
                  <button className="todo-delete" onClick={() => mutate.delete(todo.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {todos.length > 0 && (
          <div className="stats">
            <div><span>{completedCount}</span> completed</div>
            <div><span>{todos.length - completedCount}</span> remaining</div>
          </div>
        )}
        <div className="connection-status">
          <span className={`status-dot ${status === 'live' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'}`} />
          {statusLabel}
        </div>
      </div>
    </div>
  );
}

export default App;
