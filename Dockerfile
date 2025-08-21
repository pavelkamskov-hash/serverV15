FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Copy application files
COPY . .

# Install required Python packages for Excel reporting
RUN pip install --no-cache-dir openpyxl

# Expose the port used by the Python server
EXPOSE 3000

# Default command: run the Python server
CMD ["python", "server.py"]