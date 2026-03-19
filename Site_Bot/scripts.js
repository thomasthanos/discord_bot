// Auto-refresh every 2 minutes (optional, since we have live updates)
setInterval(() => {
    location.reload();
}, 120000);

// Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Bot Status update
async function updateBotStatus() {
    try {
        const response = await fetch('/bot_status');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const status = await response.json();
        
        const statusText = document.getElementById('status-text');
        const uptimeText = document.getElementById('uptime-text');
        const serversText = document.getElementById('servers-text');
        const usersText = document.getElementById('users-text');
        
        // Ενημέρωση μόνο αν το στοιχείο υπάρχει
        if (statusText) {
            statusText.textContent = status.online ? 'Online' : 'Offline';
            statusText.style.color = status.online ? '#67c167' : '#ff6347';
        }
        if (uptimeText) {
            uptimeText.textContent = status.uptime;
        }
        if (serversText) {
            serversText.textContent = status.servers;
        }
        if (usersText) {
            usersText.textContent = status.users;
        }
    } catch (error) {
        console.error('Error updating bot status:', error);
        const statusText = document.getElementById('status-text');
        if (statusText) {
            statusText.textContent = 'Error';
            statusText.style.color = '#ff6347';
        }
    }
}
// Sorting functionality
document.querySelectorAll('th').forEach(header => {
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
        const table = header.closest('table');
        const tbody = table.querySelector('tbody');
        const index = Array.from(header.parentElement.children).indexOf(header);
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const isAscending = header.classList.toggle('asc');

        rows.sort((a, b) => {
            const aText = a.children[index].textContent.trim();
            const bText = b.children[index].textContent.trim();
            return isAscending ? aText.localeCompare(bText, undefined, { numeric: true }) : bText.localeCompare(aText, undefined, { numeric: true });
        });

        rows.forEach(row => tbody.appendChild(row));
        updatePagination();
        updateStats();
    });
});

// Pagination variables
let currentPage = 1;
let rowsPerPage = parseInt(document.getElementById('rows-per-page')?.value) || 10;

function updatePagination() {
    const rows = Array.from(document.querySelectorAll('#log-body tr'));
    searchLogs();
    const visibleRows = rows.filter(row => row.style.display !== 'none');
    const totalPages = Math.max(1, Math.ceil(visibleRows.length / rowsPerPage));
    currentPage = Math.min(currentPage, totalPages) || 1;

    rows.forEach((row, index) => {
        const start = (currentPage - 1) * rowsPerPage;
        const end = start + rowsPerPage;
        if (row.style.display !== 'none') {
            row.style.display = (index >= start && index < end) ? '' : 'none';
        }
    });

    const pageInfo = document.getElementById('page-info');
    const prevPage = document.getElementById('prev-page');
    const nextPage = document.getElementById('next-page');
    if (pageInfo && prevPage && nextPage) {
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
        prevPage.disabled = currentPage === 1;
        nextPage.disabled = currentPage >= totalPages;
    }
    updateStats();
}

// Populate filter dropdowns
function populateFilters() {
    const servers = new Set();
    const users = new Set();
    const actions = new Set();
    document.querySelectorAll('#log-body tr').forEach(row => {
        servers.add(row.cells[0].textContent.trim());
        users.add(row.cells[1].textContent.trim());
        const actionText = row.cells[3].textContent.trim().replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
        actions.add(actionText);
    });

    const serverFilter = document.getElementById('server-filter');
    const userFilter = document.getElementById('user-filter');
    const actionFilter = document.getElementById('action-filter');
    if (serverFilter && userFilter && actionFilter) {
        serverFilter.innerHTML = '<option value="">All Servers</option>';
        userFilter.innerHTML = '<option value="">All Users</option>';
        actionFilter.innerHTML = '<option value="">All Actions</option>';
        servers.forEach(server => serverFilter.add(new Option(server, server)));
        users.forEach(user => userFilter.add(new Option(user, user)));
        actions.forEach(action => actionFilter.add(new Option(action, action)));
    }
}

// Update statistics
function updateStats() {
    const rows = Array.from(document.querySelectorAll('#log-body tr')).filter(row => row.style.display !== 'none');
    const totalLogsDiv = document.getElementById('total-logs');
    const logsByServerDiv = document.getElementById('logs-by-server');
    const actionsByTypeDiv = document.getElementById('actions-by-type');

    if (totalLogsDiv && logsByServerDiv && actionsByTypeDiv) {
        const totalLogs = rows.length;
        totalLogsDiv.textContent = `Total Logs: ${totalLogs}`;

        const logsByServer = {};
        const actionsByType = {};
        rows.forEach(row => {
            const server = row.cells[0].textContent.trim();
            const action = row.cells[3].textContent.trim().replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
            logsByServer[server] = (logsByServer[server] || 0) + 1;
            actionsByType[action] = (actionsByType[action] || 0) + 1;
        });

        logsByServerDiv.innerHTML = '<strong>Logs by Server:</strong><br>';
        Object.entries(logsByServer).forEach(([server, count]) => {
            logsByServerDiv.innerHTML += `${server}: ${count}<br>`;
        });

        actionsByTypeDiv.innerHTML = '<strong>Actions by Type:</strong><br>';
        Object.entries(actionsByType).forEach(([action, count]) => {
            actionsByTypeDiv.innerHTML += `${action}: ${count}<br>`;
        });
    }
}

// Search functionality with filters
function searchLogs() {
    const search = document.getElementById('search');
    const serverFilter = document.getElementById('server-filter');
    const userFilter = document.getElementById('user-filter');
    const actionFilter = document.getElementById('action-filter');
    const dateStart = document.getElementById('date-start');
    const dateEnd = document.getElementById('date-end');
    const rows = document.querySelectorAll('#log-body tr');

    if (search && serverFilter && userFilter && actionFilter && dateStart && dateEnd) {
        const searchText = search.value.toLowerCase().trim();
        const serverValue = serverFilter.value;
        const userValue = userFilter.value;
        const actionValue = actionFilter.value;
        const dateStartValue = dateStart.value;
        const dateEndValue = dateEnd.value;

        rows.forEach(row => {
            const server = row.cells[0].textContent.toLowerCase();
            const user = row.cells[1].textContent.toLowerCase();
            const action = row.cells[3].textContent.toLowerCase();
            const timestamp = row.cells[5].textContent.trim();
            const text = row.textContent.toLowerCase();

            const matchesText = !searchText || text.includes(searchText);
            const matchesServer = !serverValue || server === serverValue.toLowerCase();
            const matchesUser = !userValue || user === userValue.toLowerCase();
            const matchesAction = !actionValue || action.includes(actionValue.toLowerCase());
            const matchesDate = (!dateStartValue || timestamp >= dateStartValue) && (!dateEndValue || timestamp <= dateEndValue);

            row.style.display = (matchesText && matchesServer && matchesUser && matchesAction && matchesDate) ? '' : 'none';

            row.querySelectorAll('.content').forEach(content => {
                const originalContent = content.textContent;
                if (searchText && text.includes(searchText)) {
                    content.innerHTML = originalContent.replace(new RegExp(searchText, 'gi'), match => `<span class="highlight">${match}</span>`);
                } else {
                    content.innerHTML = originalContent;
                }
            });
        });
    }
}

// WebSocket Setup for Live Updates with Error Handling
let socket;
let retryCount = 0;
const maxRetries = 5;

function initializeWebSocket() {
    if (typeof io !== 'undefined') {
        socket = io('http://127.0.0.1:5000', {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 2000,
            timeout: 20000,
            pingInterval: 10000,
            pingTimeout: 5000
        });

        socket.on('connect', () => {
            retryCount = 0;
        });

        socket.on('status', (data) => {
        });

        socket.on('update_logs', (data) => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(data.html, 'text/html');
            const newBody = doc.getElementById('log-body');
            if (newBody) {
                const currentBody = document.getElementById('log-body');
                currentBody.innerHTML = newBody.innerHTML;
                populateFilters();
                updatePagination();
                updateStats();
                document.querySelectorAll('.expand-btn').forEach(button => {
                    button.addEventListener('click', () => {
                        const messageList = button.nextElementSibling;
                        const row = button.closest('tr');
                        const userCell = row.querySelector('td:nth-child(2)');
                        const messagesCell = row.querySelector('td:nth-child(5)');

                        messageList.classList.toggle('hidden');
                        const messageCount = messageList.children.length;
                        button.textContent = messageList.classList.contains('hidden') 
                            ? `Show ${messageCount} Messages` 
                            : 'Hide Messages';

                        userCell.classList.toggle('user-shrink');
                        messagesCell.classList.toggle('messages-expand');
                    });
                });
            }
        });

        socket.on('disconnect', () => {
            if (retryCount < maxRetries) {
                setTimeout(initializeWebSocket, 2000);
                retryCount++;
            }
        });

        socket.on('error', (error) => {
        });
    } else {
        retryCount++;
        if (retryCount < maxRetries) {
            setTimeout(initializeWebSocket, 2000);
        }
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    updateBotStatus();
    setInterval(updateBotStatus, 10000);
    populateFilters();
    updateStats();
    initializeWebSocket();

    document.querySelectorAll('.expand-btn').forEach(button => {
        button.addEventListener('click', () => {
            const messageList = button.nextElementSibling;
            const row = button.closest('tr');
            const userCell = row.querySelector('td:nth-child(2)');
            const messagesCell = row.querySelector('td:nth-child(5)');

            messageList.classList.toggle('hidden');
            const messageCount = messageList.children.length;
            button.textContent = messageList.classList.contains('hidden') 
                ? `Show ${messageCount} Messages` 
                : 'Hide Messages';

            userCell.classList.toggle('user-shrink');
            messagesCell.classList.toggle('messages-expand');
        });
    });

    const deleteLogsBtn = document.getElementById('delete-logs-btn');
    if (deleteLogsBtn) {
        deleteLogsBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete all logs? This cannot be undone.')) {
                try {
                    const response = await fetch('/delete', { method: 'POST' });
                    const data = await response.text();
                    if (response.ok) {
                        const logBody = document.getElementById('log-body');
                        if (logBody) {
                            logBody.innerHTML = '<!-- Logs will be inserted here -->';
                            alert('Logs deleted successfully!');
                            updateStats();
                            updatePagination();
                        }
                    } else {
                        throw new Error(data);
                    }
                } catch (error) {
                    alert('Failed to delete logs. Please try again.');
                }
            }
        });
    }

    const debouncedSearchLogs = debounce(searchLogs, 300);
    const search = document.getElementById('search');
    const serverFilter = document.getElementById('server-filter');
    const userFilter = document.getElementById('user-filter');
    const actionFilter = document.getElementById('action-filter');
    const dateStart = document.getElementById('date-start');
    const dateEnd = document.getElementById('date-end');
    if (search) search.addEventListener('keyup', debouncedSearchLogs);
    if (serverFilter) serverFilter.addEventListener('change', debouncedSearchLogs);
    if (userFilter) userFilter.addEventListener('change', debouncedSearchLogs);
    if (actionFilter) actionFilter.addEventListener('change', debouncedSearchLogs);
    if (dateStart) dateStart.addEventListener('change', debouncedSearchLogs);
    if (dateEnd) dateEnd.addEventListener('change', debouncedSearchLogs);

    const prevPage = document.getElementById('prev-page');
    if (prevPage) {
        prevPage.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                updatePagination();
            }
        });
    }

    const nextPage = document.getElementById('next-page');
    if (nextPage) {
        nextPage.addEventListener('click', () => {
            const rows = Array.from(document.querySelectorAll('#log-body tr'));
            searchLogs();
            const visibleRows = rows.filter(row => row.style.display !== 'none');
            const totalPages = Math.ceil(visibleRows.length / rowsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                updatePagination();
            }
        });
    }

    const rowsPerPageSelect = document.getElementById('rows-per-page');
    if (rowsPerPageSelect) {
        rowsPerPageSelect.addEventListener('change', (e) => {
            rowsPerPage = parseInt(e.target.value);
            currentPage = 1;
            updatePagination();
        });
    }

    updatePagination();
});