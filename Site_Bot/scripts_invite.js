// scripts_invite.js

const socket = io('/');

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

function initializeWebSocket() {
    socket.on('connect', () => {
        console.log('WebSocket connected successfully!');
    });

    socket.on('disconnect', (reason) => {
        console.log('WebSocket disconnected. Reason:', reason);
        console.log('Retrying...');
    });

    socket.on('new_invite_log', (data) => {
        const tbody = document.getElementById('log-body');
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${data.event_type}</td>
            <td>${data.member}<br><span class="subtext">${data.discord_id}</span></td>
            <td>${data.inviter}</td>
            <td>${data.invite_code}<br><span class="subtext">${data.expires_at}</span></td>
            <td>${data.max_uses}<br><span class="subtext">${data.uses}</span></td>
            <td>${data.is_temporary}</td>
            <td class="timestamp">${data.timestamp}</td>
            <td>${data.server}</td>
            <td>${data.inviter_role}</td>
            <td>${data.source}<br><span class="subtext">${data.join_method}</span></td>
            <td>${data.notes}</td>
            <td>${data.invite_created}</td>
        `;
        tbody.insertBefore(row, tbody.firstChild);
        const rows = tbody.querySelectorAll('tr');
        populateFilters(rows);
        updatePagination();
    });

    socket.on('update_invite_logs', (data) => {
        document.getElementById('log-body').innerHTML = data.html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)[1];
        const rows = document.getElementById('log-body').querySelectorAll('tr');
        populateFilters(rows);
        updatePagination();
    });
}

function populateFilters(rows) {
    const eventTypeFilter = document.getElementById('event-type-filter');
    const memberFilter = document.getElementById('member-filter');
    const inviterFilter = document.getElementById('inviter-filter');
    const serverFilter = document.getElementById('server-filter');

    [eventTypeFilter, memberFilter, inviterFilter, serverFilter].forEach(filter => {
        while (filter.options.length > 1) filter.remove(1);
    });

    const eventTypes = new Set();
    const members = new Set();
    const inviters = new Set();
    const servers = new Set();

    rows.forEach(row => {
        eventTypes.add(row.cells[0].textContent.trim());  // Command
        members.add(row.cells[1].textContent.split('\n')[0].trim());  // Member (name only)
        inviters.add(row.cells[2].textContent.trim());    // Inviter
        servers.add(row.cells[7].textContent.trim());     // Server
    });

    eventTypes.forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        eventTypeFilter.appendChild(option);
    });
    members.forEach(member => {
        const option = document.createElement('option');
        option.value = member;
        option.textContent = member;
        memberFilter.appendChild(option);
    });
    inviters.forEach(inviter => {
        const option = document.createElement('option');
        option.value = inviter;
        option.textContent = inviter;
        inviterFilter.appendChild(option);
    });
    servers.forEach(server => {
        const option = document.createElement('option');
        option.value = server;
        option.textContent = server;
        serverFilter.appendChild(option);
    });
}

function applyFiltersAndSearch() {
    const rows = document.getElementById('log-body').querySelectorAll('tr');
    const searchInput = document.getElementById('search').value.toLowerCase();
    const eventTypeFilter = document.getElementById('event-type-filter').value;
    const memberFilter = document.getElementById('member-filter').value;
    const inviterFilter = document.getElementById('inviter-filter').value;
    const serverFilter = document.getElementById('server-filter').value;

    rows.forEach(row => {
        const cells = row.cells;
        const text = Array.from(cells).map(cell => cell.textContent.toLowerCase()).join(' ');
        const matchesSearch = text.includes(searchInput);
        const matchesEventType = !eventTypeFilter || cells[0].textContent === eventTypeFilter;
        const matchesMember = !memberFilter || cells[1].textContent.split('\n')[0].trim() === memberFilter;
        const matchesInviter = !inviterFilter || cells[2].textContent === inviterFilter;
        const matchesServer = !serverFilter || cells[7].textContent === serverFilter;

        row.style.display = (matchesSearch && matchesEventType && matchesMember && matchesInviter && matchesServer) ? '' : 'none';
    });

    updatePagination();
}

let currentPage = 1;
const rowsPerPageSelect = document.getElementById('rows-per-page');

function updatePagination() {
    const rows = Array.from(document.getElementById('log-body').querySelectorAll('tr'))
        .filter(row => row.style.display !== 'none');
    const rowsPerPage = parseInt(rowsPerPageSelect.value);
    const totalPages = Math.ceil(rows.length / rowsPerPage);

    currentPage = Math.min(currentPage, totalPages || 1);
    currentPage = Math.max(currentPage, 1);

    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;

    rows.forEach((row, index) => {
        row.style.display = (index >= start && index < end && row.style.display !== 'none') ? '' : 'none';
    });

    document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prev-page').disabled = currentPage === 1;
    document.getElementById('next-page').disabled = currentPage === totalPages || totalPages === 0;
}

document.addEventListener('DOMContentLoaded', () => {
    initializeWebSocket();

    const tbody = document.getElementById('log-body');
    const initialRows = tbody.querySelectorAll('tr');
    populateFilters(initialRows);
    applyFiltersAndSearch();

    // Κλήση της updateBotStatus κατά την εκκίνηση
    updateBotStatus();
    // Περιοδική ενημέρωση κάθε 30 δευτερόλεπτα
    setInterval(updateBotStatus, 30000);

    document.getElementById('search').addEventListener('input', applyFiltersAndSearch);
    document.getElementById('event-type-filter').addEventListener('change', applyFiltersAndSearch);
    document.getElementById('member-filter').addEventListener('change', applyFiltersAndSearch);
    document.getElementById('inviter-filter').addEventListener('change', applyFiltersAndSearch);
    document.getElementById('server-filter').addEventListener('change', applyFiltersAndSearch);

    document.getElementById('prev-page').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            updatePagination();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        const totalPages = Math.ceil(
            Array.from(document.getElementById('log-body').querySelectorAll('tr'))
                .filter(row => row.style.display !== 'none').length / parseInt(rowsPerPageSelect.value)
        );
        if (currentPage < totalPages) {
            currentPage++;
            updatePagination();
        }
    });

    rowsPerPageSelect.addEventListener('change', () => {
        currentPage = 1;
        updatePagination();
    });

    document.getElementById('delete-logs-btn').addEventListener('click', () => {
        if (confirm('Are you sure you want to delete all invite logs?')) {
            fetch('/delete_invite_logs', { method: 'POST' })
                .then(response => response.json())
                .then(data => alert(data.message))
                .catch(error => console.error('Error deleting logs:', error));
        }
    });

    document.getElementById('view-logs-btn').addEventListener('click', () => {
        window.location.href = '/logs';
    });

    setInterval(() => {
        socket.emit('request_update_invite_logs');
    }, 120000);
});