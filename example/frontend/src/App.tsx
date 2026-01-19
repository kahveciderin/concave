import { getOrCreateClient } from 'concave/client';
import { useAuth, useLiveList, usePublicEnv, useSearch } from 'concave/client/react';
import { AuthForm } from './components/AuthForm';
import type { Todo, User, Category, Tag } from './generated/api-types';
import { useState, useEffect } from 'react';

interface PublicEnv {
  PUBLIC_VERSION: string;
  PUBLIC_OPENSEARCH_ENABLED: boolean;
}

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
  const { env } = usePublicEnv<PublicEnv>();

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
          {env?.PUBLIC_VERSION && (
            <div className="version-badge">v{env.PUBLIC_VERSION}</div>
          )}
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <AuthForm onLogin={() => window.location.reload()} version={env?.PUBLIC_VERSION} />;
  }

  return <TodoApp user={user} onLogout={logout} version={env?.PUBLIC_VERSION} searchEnabled={env?.PUBLIC_OPENSEARCH_ENABLED} />;
}

function TodoApp({ user, onLogout, version, searchEnabled }: { user: User; onLogout: () => void; version?: string; searchEnabled?: boolean }) {
  const [newTodo, setNewTodo] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('#6366f1');
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch todos with relations (paginated - 5 items at a time)
  const {
    items: todos,
    status,
    statusLabel,
    mutate,
    hasMore,
    totalCount,
    isLoadingMore,
    loadMore,
  } = useLiveList<TodoWithRelations>(
    '/api/todos',
    { orderBy: 'position', include: 'category,tags', limit: 5 }
  );

  // Fetch categories for the dropdown
  const { items: categories, mutate: categoryMutate } = useLiveList<Category>(
    '/api/categories',
    { orderBy: 'name' }
  );

  // Search functionality using the useSearch hook
  const {
    items: searchResults,
    isSearching,
    search,
    clear: clearSearch,
  } = useSearch<TodoWithRelations>('/api/todos', { enabled: searchEnabled });

  // Update search when query changes
  useEffect(() => {
    search(searchQuery);
  }, [searchQuery, search]);

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
          {/* Search bar (only when OpenSearch is enabled) */}
          {searchEnabled && (
            <div className="search-section">
              <div className="search-input-row">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search todos..."
                  className="search-input"
                />
                {searchQuery && (
                  <button className="search-clear" onClick={() => { clearSearch(); setSearchQuery(''); }}>×</button>
                )}
                {isSearching && <span className="search-indicator">Searching...</span>}
              </div>
              {searchQuery.trim() !== '' && (
                <div className="search-results">
                  <div className="search-results-header">
                    <span>{searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found</span>
                    <button className="btn btn-secondary btn-small" onClick={() => { clearSearch(); setSearchQuery(''); }}>Clear</button>
                  </div>
                  {searchResults.length === 0 ? (
                    <div className="empty-state">
                      <p>No todos match your search.</p>
                    </div>
                  ) : (
                    <ul className="todo-list search-results-list">
                      {searchResults.map((todo) => (
                        <li key={todo.id} className="todo-item">
                          <div
                            className={`todo-checkbox${todo.completed ? ' checked' : ''}`}
                            onClick={() => mutate.update(todo.id, { completed: !todo.completed })}
                          />
                          <div className="todo-content">
                            <span className={`todo-title${todo.completed ? ' completed' : ''}`}>
                              {todo.title}
                            </span>
                            {todo.description && (
                              <span className="todo-description">{todo.description}</span>
                            )}
                          </div>
                          <button className="todo-delete" onClick={() => mutate.delete(todo.id)}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

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
                    {(() => {
                      // Use included relation if available, otherwise look up from categories list
                      // This handles optimistic updates where the relation is cleared but categoryId is set
                      const displayCategory = todo.category ?? categories.find(c => c.id === todo.categoryId);
                      return (displayCategory || (todo.tags && todo.tags.length > 0)) && (
                        <div className="todo-meta">
                          {displayCategory && (
                            <span
                              className="todo-category"
                              style={{ backgroundColor: displayCategory.color || '#6366f1' }}
                            >
                              {displayCategory.name}
                            </span>
                          )}
                          {todo.tags && todo.tags.map((tag) => (
                          <span key={tag.id} className="todo-tag">
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    );
                    })()}
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

          {/* Pagination */}
          {hasMore && (
            <div className="pagination">
              <button
                className="btn btn-secondary"
                onClick={loadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </div>
        {todos.length > 0 && (
          <div className="stats">
            <div><span>{completedCount}</span> completed</div>
            <div><span>{todos.length - completedCount}</span> remaining</div>
            {totalCount !== undefined && (
              <div><span>{todos.length}</span> of <span>{totalCount}</span> loaded</div>
            )}
          </div>
        )}
        <div className="connection-status">
          <span className={`status-dot ${status === 'live' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : 'disconnected'}`} />
          {statusLabel}
          {version && <span className="version-text">v{version}</span>}
        </div>
      </div>
    </div>
  );
}

export default App;
