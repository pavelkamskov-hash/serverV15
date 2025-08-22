FROM python:3.9-slim

# Set timezone
ENV TZ=Etc/GMT-4

# Set working directory
WORKDIR /app

# Copy application files
COPY . .

# Install required Python packages for Excel reporting and authentication
RUN pip install --no-cache-dir openpyxl bcrypt

# Expose the port used by the Python server
EXPOSE 3000

# Default command: run the Python server
CMD ["python", "server.py"]