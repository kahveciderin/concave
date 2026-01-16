import { getOrCreateClient } from 'concave/client';
import { useAuth, useLiveList } from 'concave/client/react';
import { AuthForm } from './components/AuthForm';
import type { Todo, User, Category, Tag } from './generated/api-types';
import { useState, useEffect } from 'react';

// Extended Todo type with included relations
interface TodoWithRelations extends Todo {
  category?: Category | null;
  tags?: Tag[];
}

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
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('#6366f1');

  // Fetch todos with relations
  const { items: todos, status, statusLabel, mutate } = useLiveList<TodoWithRelations>(
    '/api/todos',
    { orderBy: 'position', include: 'category,tags' }
  );

  // Fetch categories for the dropdown
  const { items: categories, mutate: categoryMutate } = useLiveList<Category>(
    '/api/categories',
    { orderBy: 'name' }
  );

  const addTodo = () => {
    if (!newTodo.trim()) return;
    mutate.create({
      title: newTodo.trim(),
      categoryId: selectedCategoryId,
    } as Omit<Todo, 'id'>);
    setNewTodo('');
  };

  const addCategory = () => {
    if (!newCategoryName.trim()) return;
    categoryMutate.create({
      name: newCategoryName.trim(),
      color: newCategoryColor,
    } as Omit<Category, 'id'>);
    setNewCategoryName('');
    setShowCategoryForm(false);
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
          {/* Todo input with category selector */}
          <div className="todo-input-row">
            <input
              type="text"
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTodo()}
              placeholder="What needs to be done?"
            />
            <select
              value={selectedCategoryId ?? ''}
              onChange={(e) => setSelectedCategoryId(e.target.value || null)}
              className="category-select"
            >
              <option value="">No category</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={addTodo}>Add</button>
          </div>

          {/* Category management */}
          <div className="category-section">
            {!showCategoryForm ? (
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setShowCategoryForm(true)}
              >
                + New Category
              </button>
            ) : (
              <div className="category-form">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCategory()}
                  placeholder="Category name"
                  className="category-input"
                />
                <input
                  type="color"
                  value={newCategoryColor}
                  onChange={(e) => setNewCategoryColor(e.target.value)}
                  className="color-picker"
                />
                <button className="btn btn-primary btn-small" onClick={addCategory}>
                  Add
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => setShowCategoryForm(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            {categories.length > 0 && (
              <div className="category-chips">
                {categories.map((cat) => (
                  <span
                    key={cat.id}
                    className="category-chip"
                    style={{ backgroundColor: cat.color || '#6366f1' }}
                  >
                    {cat.name}
                  </span>
                ))}
              </div>
            )}
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
                  <div className="todo-content">
                    <span className={`todo-title${todo.completed ? ' completed' : ''}`}>
                      {todo.title}
                    </span>
                    {(todo.category || (todo.tags && todo.tags.length > 0)) && (
                      <div className="todo-meta">
                        {todo.category && (
                          <span
                            className="todo-category"
                            style={{ backgroundColor: todo.category.color || '#6366f1' }}
                          >
                            {todo.category.name}
                          </span>
                        )}
                        {todo.tags && todo.tags.map((tag) => (
                          <span key={tag.id} className="todo-tag">
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Category quick-assign dropdown */}
                  <select
                    value={todo.categoryId ?? ''}
                    onChange={(e) =>
                      mutate.update(todo.id, { categoryId: e.target.value || null })
                    }
                    className="todo-category-select"
                    title="Assign category"
                  >
                    <option value="">-</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
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
